import path from "path";
import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const IKM_COMPANY_ID = 2;
const ADMIN_EMPLOYEE_ID = 31;
const ALLOWED_STATUSES = new Set(["pengajuan", "disetujui", "ditolak"]);
const ALLOWED_LEAVE_TYPES = new Set(["izin", "sakit", "cuti"]);

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function toActorName(value) {
	const actor = String(value || "").trim().slice(0, 255);
	return actor || null;
}

function resolveApprovedBy(req) {
	return (
		toActorName(req.body?.approved_by) ||
		toActorName(req.session?.user?.employee?.full_name) ||
		toActorName(req.session?.user?.name) ||
		toActorName(req.session?.userName) ||
		toActorName(req.session?.user?.username) ||
		toActorName(req.session?.user?.employee_id) ||
		toActorName(req.session?.employeeId) ||
		"admin"
	);
}

function buildLeavePhotoUrl(fileName) {
	if (!fileName) return null;
	if (/^https?:\/\//i.test(fileName)) return fileName;
	const base = (process.env.IKM_PHOTO_LEAVE_BASE_URL || "https://api.ikmalora.com/storage/suratketerangan").replace(/\/+$/, "");
	const name = path.basename(fileName);
	return `${base}/${name}`;
}

async function getEmployeeMap(employeeCodes) {
	if (!employeeCodes || employeeCodes.length === 0) return new Map();

	const uniqueCodes = [...new Set(employeeCodes.filter(Boolean))];
	if (uniqueCodes.length === 0) return new Map();

	const placeholders = uniqueCodes.map(() => "?").join(",");

	// Join on employee_code (varchar) OR on CAST(employee_id AS CHAR)
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name,
				p.position_name,
				j.job_level_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			WHERE e.is_deleted = 0
				AND (e.company_id = ? OR e.employee_id = ?)
				AND (
					e.employee_code IN (${placeholders})
					OR CAST(e.employee_id AS CHAR) IN (${placeholders})
				)
		`,
		[IKM_COMPANY_ID, ADMIN_EMPLOYEE_ID, ...uniqueCodes, ...uniqueCodes]
	);

	const map = new Map();
	for (const row of rows) {
		// Map by employee_code
		if (row.employee_code) {
			map.set(String(row.employee_code), {
				employee_name: row.full_name || null,
				jabatan: row.job_level_name || row.position_name || "-",
			});
		}
		// Also map by employee_id string
		map.set(String(row.employee_id), {
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
		});
	}
	return map;
}

function resolveEmployeeInfo(map, employeeId) {
	const key = String(employeeId || "");
	const found = map.get(key);
	return {
		employee_name: found?.employee_name || `ID ${employeeId}`,
		jabatan: found?.jabatan || "-",
	};
}

// ─── GET /ikm/leaves ──────────────────────────────────────────────────────────
export const getLeaves = async (req, res) => {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const startDate = toISODateString(req.query.startDate) || null;
		const endDate = toISODateString(req.query.endDate) || null;

		const statusFilter = String(req.query.status || "").toLowerCase();
		if (statusFilter && !ALLOWED_STATUSES.has(statusFilter)) {
			return res.status(400).json({ message: "Status tidak valid. Gunakan: pengajuan, disetujui, ditolak" });
		}

		const leaveTypeFilter = String(req.query.leaveType || "").toLowerCase();
		if (leaveTypeFilter && !ALLOWED_LEAVE_TYPES.has(leaveTypeFilter)) {
			return res.status(400).json({ message: "Tipe cuti tidak valid. Gunakan: izin, sakit, cuti" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;

		const search = String(req.query.search || "").trim().slice(0, 100);

		// Build WHERE
		const where = ["1=1"];
		const params = [];

		if (startDate) {
			where.push("l.start_date >= ?");
			params.push(startDate);
		}

		if (endDate) {
			where.push("l.end_date <= ?");
			params.push(endDate);
		}

		if (statusFilter) {
			where.push("l.status = ?");
			params.push(statusFilter);
		}

		if (leaveTypeFilter) {
			where.push("l.leave_type = ?");
			params.push(leaveTypeFilter);
		}

		if (search) {
			where.push("l.employee_id LIKE ?");
			params.push(`%${search}%`);
		}

		const whereSql = where.join(" AND ");

		// Count total
		const [countRows] = await safeIKMQuery(
			`SELECT COUNT(*) AS total FROM tr_employee_leaves l WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		// Fetch records
		const [rows] = await safeIKMQuery(
			`
				SELECT
					l.id,
					l.employee_id,
					l.leave_type,
					l.duration_type,
					l.start_date,
					l.end_date,
					l.reason,
					l.doctor_note_path,
					l.status,
					l.rejection_note,
					l.approved_by,
					l.approved_at,
					l.created_at,
					l.updated_at
				FROM tr_employee_leaves l
				WHERE ${whereSql}
				ORDER BY l.created_at DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		// Enrich with employee names
		const employeeCodes = [...new Set(rows.map((r) => String(r.employee_id || "")))];
		const employeeMap = await getEmployeeMap(employeeCodes);

		const records = rows.map((row) => {
			const empInfo = resolveEmployeeInfo(employeeMap, row.employee_id);
			return {
				...row,
				employee_name: empInfo.employee_name,
				jabatan: empInfo.jabatan,
				doctor_note_url: buildLeavePhotoUrl(row.doctor_note_path),
			};
		});

		// Summary counts
		const [summaryRows] = await safeIKMQuery(
			`
				SELECT
					status,
					COUNT(*) AS cnt
				FROM tr_employee_leaves
				GROUP BY status
			`,
			[]
		);

		const statusCounts = { pengajuan: 0, disetujui: 0, ditolak: 0 };
		for (const r of summaryRows) {
			if (r.status in statusCounts) {
				statusCounts[r.status] = Number(r.cnt);
			}
		}

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
			statusCounts,
		});
	} catch (err) {
		console.error("[getLeaves] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data perizinan" });
	}
};

// ─── PUT /ikm/leaves/:id/approve ─────────────────────────────────────────────
export const approveLeave = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const approvedBy = resolveApprovedBy(req);

		const [result] = await safeIKMQuery(
			`
				UPDATE tr_employee_leaves
				SET status = 'disetujui',
					rejection_note = NULL,
					approved_by = ?,
					approved_at = NOW(),
					updated_at = NOW()
				WHERE id = ? AND status = 'pengajuan'
			`,
			[approvedBy, id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Data tidak ditemukan atau sudah diproses sebelumnya" });
		}

		return res.json({ message: "Pengajuan berhasil disetujui" });
	} catch (err) {
		console.error("[approveLeave] Error:", err);
		return res.status(500).json({ message: "Gagal menyetujui pengajuan" });
	}
};

// ─── PUT /ikm/leaves/:id/reject ──────────────────────────────────────────────
export const rejectLeave = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const rejectionNote = String(req.body?.rejection_note || "").trim().slice(0, 1000);

		const rejectedBy = resolveApprovedBy(req);

		const [result] = await safeIKMQuery(
			`
				UPDATE tr_employee_leaves
				SET status = 'ditolak',
					rejection_note = ?,
					approved_by = ?,
					approved_at = NOW(),
					updated_at = NOW()
				WHERE id = ? AND status = 'pengajuan'
			`,
			[rejectionNote || null, rejectedBy, id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Data tidak ditemukan atau sudah diproses sebelumnya" });
		}

		return res.json({ message: "Pengajuan berhasil ditolak" });
	} catch (err) {
		console.error("[rejectLeave] Error:", err);
		return res.status(500).json({ message: "Gagal menolak pengajuan" });
	}
};
