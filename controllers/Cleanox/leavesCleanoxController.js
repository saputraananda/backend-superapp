import fs from "fs";
import path from "path";
import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";

const ALLOWED_STATUSES = new Set(["pengajuan", "disetujui", "ditolak"]);
const ALLOWED_LEAVE_TYPES = new Set(["izin", "sakit", "cuti"]);
const CLEANOX_COMPANY_ID = 3;

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function toDateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) {
		const y = value.getFullYear();
		const m = String(value.getMonth() + 1).padStart(2, "0");
		const d = String(value.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	return String(value).slice(0, 10);
}

function toActorName(value) {
	const actor = String(value || "").trim().slice(0, 255);
	return actor || null;
}

function resolveApprovedByName(req) {
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

function resolveApprovedById(req) {
	const candidates = [
		req.session?.user?.id,
		req.session?.user?.user_id,
		req.session?.userId,
		req.session?.id,
	];
	for (const c of candidates) {
		const n = toPositiveInt(c);
		if (n) return n;
	}
	return null;
}

function getLeaveDir() {
	const dir = process.env.CLEANOX_LEAVE_DIR;
	if (dir) return path.resolve(dir);

	const attendanceDir = process.env.CLEANOX_ATTENDANCE_DIR;
	if (attendanceDir) {
		return path.resolve(path.dirname(attendanceDir), "worker-leave");
	}
	return null;
}

function buildDoctorNoteUrl(fileName) {
	if (!fileName) return null;
	return `/cleanox/leaves/doctor-notes/${encodeURIComponent(path.basename(fileName))}`;
}

async function getEmployeeMap(workerIds) {
	const uniqueIds = [...new Set(workerIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();

	const placeholders = uniqueIds.map(() => "?").join(",");
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
				AND e.company_id = ?
				AND e.employee_id IN (${placeholders})
		`,
		[CLEANOX_COMPANY_ID, ...uniqueIds]
	);

	const roleMap = new Map();
	try {
		const [roleRows] = await safeCleanoxQuery("SELECT employee_id, role FROM mst_role");
		for (const r of roleRows || []) {
			roleMap.set(Number(r.employee_id), r.role || null);
		}
	} catch {
		// optional
	}

	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name || null,
			employee_code: row.employee_code || null,
			jabatan: row.job_level_name || row.position_name || "-",
			cleanox_role: roleMap.get(Number(row.employee_id)) || null,
		});
	}
	return map;
}

export const getLeaves = async (req, res) => {
	try {
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

		let workerIdFilter = null;
		if (search) {
			const like = `%${search}%`;
			const [empRows] = await safeQuery(
				`
					SELECT e.employee_id
					FROM mst_employee e
					WHERE e.is_deleted = 0
						AND e.company_id = ?
						AND (
							e.full_name LIKE ?
							OR e.employee_code LIKE ?
							OR CAST(e.employee_id AS CHAR) LIKE ?
						)
				`,
				[CLEANOX_COMPANY_ID, like, like, like]
			);
			workerIdFilter = (empRows || []).map((r) => Number(r.employee_id)).filter(Boolean);
			if (workerIdFilter.length === 0) {
				return res.json({
					records: [],
					pagination: { page, limit, total: 0, totalPages: 1 },
					statusCounts: { pengajuan: 0, disetujui: 0, ditolak: 0 },
				});
			}
			where.push(`l.worker_id IN (${workerIdFilter.map(() => "?").join(",")})`);
			params.push(...workerIdFilter);
		}

		const whereSql = where.join(" AND ");

		const [countRows] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_leaves l WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					l.id,
					l.worker_id,
					l.leave_type,
					l.duration_type,
					l.start_date,
					l.end_date,
					l.reason,
					l.doctor_note_file,
					l.doctor_note_path,
					l.status,
					l.rejection_note,
					l.approved_by,
					l.approved_by_name,
					l.approved_at,
					l.created_at,
					l.updated_at
				FROM tr_worker_leaves l
				WHERE ${whereSql}
				ORDER BY l.created_at DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const employeeMap = await getEmployeeMap((rows || []).map((r) => r.worker_id));

		const records = (rows || []).map((row) => {
			const emp = employeeMap.get(Number(row.worker_id)) || {};
			return {
				...row,
				employee_id: row.worker_id,
				start_date: toDateOnly(row.start_date),
				end_date: toDateOnly(row.end_date),
				employee_name: emp.employee_name || `ID ${row.worker_id}`,
				employee_code: emp.employee_code || null,
				jabatan: emp.jabatan || "-",
				cleanox_role: emp.cleanox_role || null,
				doctor_note_url: buildDoctorNoteUrl(row.doctor_note_file),
				approved_by: row.approved_by_name || row.approved_by || null,
			};
		});

		const [summaryRows] = await safeCleanoxQuery(
			`
				SELECT status, COUNT(*) AS cnt
				FROM tr_worker_leaves
				GROUP BY status
			`,
			[]
		);

		const statusCounts = { pengajuan: 0, disetujui: 0, ditolak: 0 };
		for (const r of summaryRows || []) {
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
		console.error("[getLeaves Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data perizinan Cleanox" });
	}
};

export const approveLeave = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const approvedByName = resolveApprovedByName(req);
		const approvedById = resolveApprovedById(req);

		const [result] = await safeCleanoxQuery(
			`
				UPDATE tr_worker_leaves
				SET status = 'disetujui',
					rejection_note = NULL,
					approved_by = ?,
					approved_by_name = ?,
					approved_at = NOW(),
					updated_at = NOW()
				WHERE id = ? AND status = 'pengajuan'
			`,
			[approvedById, approvedByName, id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Data tidak ditemukan atau sudah diproses sebelumnya" });
		}

		return res.json({ message: "Pengajuan berhasil disetujui" });
	} catch (err) {
		console.error("[approveLeave Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menyetujui pengajuan" });
	}
};

export const rejectLeave = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const rejectionNote = String(req.body?.rejection_note || "").trim().slice(0, 1000);
		const approvedByName = resolveApprovedByName(req);
		const approvedById = resolveApprovedById(req);

		const [result] = await safeCleanoxQuery(
			`
				UPDATE tr_worker_leaves
				SET status = 'ditolak',
					rejection_note = ?,
					approved_by = ?,
					approved_by_name = ?,
					approved_at = NOW(),
					updated_at = NOW()
				WHERE id = ? AND status = 'pengajuan'
			`,
			[rejectionNote || null, approvedById, approvedByName, id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Data tidak ditemukan atau sudah diproses sebelumnya" });
		}

		return res.json({ message: "Pengajuan berhasil ditolak" });
	} catch (err) {
		console.error("[rejectLeave Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menolak pengajuan" });
	}
};

export const serveDoctorNote = async (req, res) => {
	try {
		const leaveDir = getLeaveDir();
		if (!leaveDir) {
			return res.status(500).json({
				message: "CLEANOX_LEAVE_DIR belum dikonfigurasi",
			});
		}

		const safeFileName = path.basename(req.params.filename || "");
		const fullPath = path.join(leaveDir, safeFileName);

		if (!fs.existsSync(fullPath)) {
			return res.status(404).json({ message: "File surat dokter tidak ditemukan" });
		}

		return res.sendFile(fullPath);
	} catch (err) {
		console.error("[serveDoctorNote Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal membuka file surat dokter" });
	}
};
