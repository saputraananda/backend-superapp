import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import { getCleanoxProduksiRoleMap } from "../../utils/cleanoxProduksiEmployees.js";

const CLEANOX_COMPANY_ID = 3;
const MAX_RANGE_DAYS = 31;

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

function resolveCreatedByName(req) {
	return (
		toActorName(req.body?.created_by_name) ||
		toActorName(req.session?.user?.employee?.full_name) ||
		toActorName(req.session?.user?.name) ||
		toActorName(req.session?.userName) ||
		toActorName(req.session?.user?.username) ||
		"admin"
	);
}

function resolveCreatedById(req) {
	const candidates = [
		req.session?.user?.id,
		req.session?.user?.user_id,
		req.session?.userId,
		req.session?.employeeId,
	];
	for (const c of candidates) {
		const n = toPositiveInt(c);
		if (n) return n;
	}
	return null;
}

function expandDateRange(startDate, endDate) {
	const dates = [];
	const cursor = new Date(`${startDate}T12:00:00`);
	const end = new Date(`${endDate}T12:00:00`);
	while (cursor <= end) {
		dates.push(toDateOnly(cursor));
		cursor.setDate(cursor.getDate() + 1);
	}
	return dates;
}

async function assertCleanoxEmployee(workerId) {
	const id = Number(workerId);
	if (!Number.isInteger(id) || id <= 0) return null;

	const roleMap = await getCleanoxProduksiRoleMap();
	if (!roleMap.has(id)) return null;

	const [rows] = await safeQuery(
		`
			SELECT employee_id, employee_code, full_name
			FROM mst_employee
			WHERE employee_id = ?
				AND company_id = ?
				AND is_deleted = 0
				AND exit_date IS NULL
			LIMIT 1
		`,
		[id, CLEANOX_COMPANY_ID]
	);

	return rows[0] || null;
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

	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name || null,
			employee_code: row.employee_code || null,
			jabatan: row.job_level_name || row.position_name || "-",
		});
	}
	return map;
}

async function findLeaveConflicts(workerId, dates) {
	if (!dates.length) return [];
	const conflicts = [];
	for (const date of dates) {
		const [rows] = await safeCleanoxQuery(
			`
				SELECT id
				FROM tr_worker_leaves
				WHERE worker_id = ?
					AND status IN ('pengajuan', 'disetujui')
					AND start_date <= ?
					AND end_date >= ?
				LIMIT 1
			`,
			[workerId, date, date]
		);
		if (rows?.length) conflicts.push(date);
	}
	return conflicts;
}

async function findExistingOffDays(workerId, dates) {
	if (!dates.length) return [];
	const ph = dates.map(() => "?").join(", ");
	const [rows] = await safeCleanoxQuery(
		`
			SELECT off_date
			FROM tr_worker_off_days
			WHERE worker_id = ?
				AND off_date IN (${ph})
		`,
		[workerId, ...dates]
	);
	return (rows || []).map((r) => toDateOnly(r.off_date)).filter(Boolean);
}

export const getOffDays = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate) || null;
		const endDate = toISODateString(req.query.endDate) || null;
		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;
		const search = String(req.query.search || "").trim().slice(0, 100);

		const where = ["1=1"];
		const params = [];

		if (startDate) {
			where.push("o.off_date >= ?");
			params.push(startDate);
		}
		if (endDate) {
			where.push("o.off_date <= ?");
			params.push(endDate);
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
			const workerIds = (empRows || []).map((r) => Number(r.employee_id)).filter(Boolean);
			if (workerIds.length === 0) {
				return res.json({
					records: [],
					pagination: { page, limit, total: 0, totalPages: 1 },
				});
			}
			where.push(`o.worker_id IN (${workerIds.map(() => "?").join(",")})`);
			params.push(...workerIds);
		}

		const whereSql = where.join(" AND ");

		const [countRows] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_off_days o WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					o.id,
					o.worker_id,
					o.off_date,
					o.note,
					o.created_by,
					o.created_by_name,
					o.created_at,
					o.updated_at
				FROM tr_worker_off_days o
				WHERE ${whereSql}
				ORDER BY o.off_date DESC, o.created_at DESC
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
				off_date: toDateOnly(row.off_date),
				status: "off",
				employee_name: emp.employee_name || `ID ${row.worker_id}`,
				employee_code: emp.employee_code || null,
				jabatan: emp.jabatan || "-",
			};
		});

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
		});
	} catch (err) {
		console.error("[getOffDays Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data libur karyawan" });
	}
};

export const createOffDays = async (req, res) => {
	try {
		const workerId = toPositiveInt(req.body?.worker_id);
		if (!workerId) {
			return res.status(400).json({ message: "worker_id tidak valid" });
		}

		const employee = await assertCleanoxEmployee(workerId);
		if (!employee) {
			return res.status(404).json({ message: "Karyawan Cleanox tidak ditemukan" });
		}

		const startDate = toISODateString(req.body?.start_date);
		const endDate = toISODateString(req.body?.end_date) || startDate;
		if (!startDate) {
			return res.status(400).json({ message: "start_date wajib diisi (YYYY-MM-DD)" });
		}
		if (startDate > endDate) {
			return res.status(400).json({ message: "end_date tidak boleh sebelum start_date" });
		}

		const dates = expandDateRange(startDate, endDate);
		if (dates.length > MAX_RANGE_DAYS) {
			return res.status(400).json({ message: `Range libur maksimal ${MAX_RANGE_DAYS} hari per pengajuan` });
		}

		const note = String(req.body?.note || "").trim().slice(0, 500) || null;
		const createdBy = resolveCreatedById(req);
		const createdByName = resolveCreatedByName(req);

		const existing = await findExistingOffDays(workerId, dates);
		if (existing.length > 0) {
			return res.status(409).json({
				message: "Beberapa tanggal libur sudah tercatat untuk karyawan ini",
				conflict_dates: existing,
			});
		}

		const leaveConflicts = await findLeaveConflicts(workerId, dates);
		if (leaveConflicts.length > 0) {
			return res.status(409).json({
				message: "Tanggal bentrok dengan izin/cuti/sakit aktif karyawan",
				conflict_dates: leaveConflicts,
			});
		}

		const insertedIds = [];
		for (const offDate of dates) {
			const [result] = await safeCleanoxQuery(
				`
					INSERT INTO tr_worker_off_days
						(worker_id, off_date, note, created_by, created_by_name)
					VALUES (?, ?, ?, ?, ?)
				`,
				[workerId, offDate, note, createdBy, createdByName]
			);
			if (result?.insertId) insertedIds.push(Number(result.insertId));
		}

		return res.status(201).json({
			message: `${dates.length} hari libur berhasil dicatat`,
			inserted_count: dates.length,
			inserted_ids: insertedIds,
		});
	} catch (err) {
		console.error("[createOffDays Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menambahkan libur karyawan" });
	}
};

export const deleteOffDay = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [result] = await safeCleanoxQuery(
			`DELETE FROM tr_worker_off_days WHERE id = ?`,
			[id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Data libur tidak ditemukan" });
		}

		return res.json({ message: "Libur karyawan berhasil dihapus" });
	} catch (err) {
		console.error("[deleteOffDay Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menghapus libur karyawan" });
	}
};
