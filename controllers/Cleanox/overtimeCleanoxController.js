import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";

const CLEANOX_COMPANY_ID = 3;
const ALLOWED_TYPES = new Set(["checkout", "pengajuan"]);
const ALLOWED_STATUSES = new Set(["aktif", "selesai"]);

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

function durationMinutes(startAt, endAt) {
	if (!startAt || !endAt) return null;
	const start = startAt instanceof Date ? startAt : new Date(startAt);
	const end = endAt instanceof Date ? endAt : new Date(endAt);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
	return Math.round((end.getTime() - start.getTime()) / 60000);
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

function mapRecord(row, emp = {}) {
	return {
		id: row.id,
		worker_id: row.worker_id,
		employee_id: row.worker_id,
		full_name: emp.employee_name || `ID ${row.worker_id}`,
		employee_name: emp.employee_name || `ID ${row.worker_id}`,
		employee_code: emp.employee_code || null,
		jabatan: emp.jabatan || "-",
		cleanox_role: emp.cleanox_role || null,
		overtime_date: toDateOnly(row.overtime_date),
		type: row.type,
		start_at: row.start_at,
		end_at: row.end_at,
		duration_minutes: durationMinutes(row.start_at, row.end_at),
		description: row.description,
		status: row.status,
		attendance_id: row.attendance_id,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export const listOvertime = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate) || null;
		const endDate = toISODateString(req.query.endDate) || null;

		const typeFilter = String(req.query.type || "").toLowerCase();
		if (typeFilter && !ALLOWED_TYPES.has(typeFilter)) {
			return res.status(400).json({ message: "Tipe tidak valid. Gunakan: checkout, pengajuan" });
		}

		const statusFilter = String(req.query.status || "").toLowerCase();
		if (statusFilter && !ALLOWED_STATUSES.has(statusFilter)) {
			return res.status(400).json({ message: "Status tidak valid. Gunakan: aktif, selesai" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;
		const search = String(req.query.search || "").trim().slice(0, 100);

		const where = ["1=1"];
		const params = [];

		if (startDate) {
			where.push("o.overtime_date >= ?");
			params.push(startDate);
		}
		if (endDate) {
			where.push("o.overtime_date <= ?");
			params.push(endDate);
		}
		if (typeFilter) {
			where.push("o.type = ?");
			params.push(typeFilter);
		}
		if (statusFilter) {
			where.push("o.status = ?");
			params.push(statusFilter);
		}

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
			const workerIdFilter = (empRows || []).map((r) => Number(r.employee_id)).filter(Boolean);
			if (workerIdFilter.length === 0) {
				return res.json({
					records: [],
					pagination: { page, limit, total: 0, totalPages: 1 },
					summary: { total: 0, total_minutes: 0, aktif: 0, selesai: 0 },
				});
			}
			where.push(`o.worker_id IN (${workerIdFilter.map(() => "?").join(",")})`);
			params.push(...workerIdFilter);
		}

		const whereSql = where.join(" AND ");

		const [countRows] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_overtime o WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					o.id,
					o.worker_id,
					o.overtime_date,
					o.type,
					o.start_at,
					o.end_at,
					o.description,
					o.status,
					o.attendance_id,
					o.created_at,
					o.updated_at
				FROM tr_worker_overtime o
				WHERE ${whereSql}
				ORDER BY o.overtime_date DESC, o.id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const employeeMap = await getEmployeeMap((rows || []).map((r) => r.worker_id));
		const records = (rows || []).map((row) => {
			const emp = employeeMap.get(Number(row.worker_id)) || {};
			return mapRecord(row, emp);
		});

		const [summaryRows] = await safeCleanoxQuery(
			`
				SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN o.status = 'aktif' THEN 1 ELSE 0 END) AS aktif,
					SUM(CASE WHEN o.status = 'selesai' THEN 1 ELSE 0 END) AS selesai,
					SUM(
						CASE
							WHEN o.end_at IS NOT NULL AND o.start_at IS NOT NULL AND o.end_at > o.start_at
							THEN TIMESTAMPDIFF(MINUTE, o.start_at, o.end_at)
							ELSE 0
						END
					) AS total_minutes
				FROM tr_worker_overtime o
				WHERE ${whereSql}
			`,
			params
		);

		const summary = {
			total: Number(summaryRows?.[0]?.total || 0),
			aktif: Number(summaryRows?.[0]?.aktif || 0),
			selesai: Number(summaryRows?.[0]?.selesai || 0),
			total_minutes: Number(summaryRows?.[0]?.total_minutes || 0),
		};

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
			summary,
		});
	} catch (err) {
		console.error("[listOvertime Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data lembur Cleanox" });
	}
};

export const getOvertimeById = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					o.id,
					o.worker_id,
					o.overtime_date,
					o.type,
					o.start_at,
					o.end_at,
					o.description,
					o.status,
					o.attendance_id,
					o.created_at,
					o.updated_at
				FROM tr_worker_overtime o
				WHERE o.id = ?
				LIMIT 1
			`,
			[id]
		);

		const row = rows?.[0];
		if (!row) return res.status(404).json({ message: "Data lembur tidak ditemukan" });

		const employeeMap = await getEmployeeMap([row.worker_id]);
		const emp = employeeMap.get(Number(row.worker_id)) || {};

		return res.json({ record: mapRecord(row, emp) });
	} catch (err) {
		console.error("[getOvertimeById Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil detail lembur Cleanox" });
	}
};
