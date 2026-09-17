import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

const HRD_POSITION_IDS = [1, 8, 17, 18, 19];
const ALLOWED_STATUSES = new Set([
	"Pending_Supervisor",
	"Pending_HRD",
	"Rejected_Supervisor",
	"Rejected_HRD",
	"disetujui",
]);
const ALLOWED_REQUEST_TYPES = new Set(["lembur", "replace_off"]);

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function toDateInput(date) {
	const d = new Date(date);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getDefaultCutoffRange(now = new Date()) {
	let cutoffMonth = now.getMonth() + 1;
	let cutoffYear = now.getFullYear();
	if (now.getDate() > 25) {
		cutoffMonth += 1;
		if (cutoffMonth > 12) {
			cutoffMonth = 1;
			cutoffYear += 1;
		}
	}
	const start = new Date(cutoffYear, cutoffMonth - 2, 26);
	const end = new Date(cutoffYear, cutoffMonth - 1, 25);
	return { startDate: toDateInput(start), endDate: toDateInput(end) };
}

function isHRDUser(employee) {
	if (!employee) return false;
	return HRD_POSITION_IDS.includes(Number(employee.position_id));
}

function isSupervisorUser(employee) {
	if (!employee) return false;
	const level = Number(employee.job_level_id);
	return !Number.isNaN(level) && level <= 3;
}

async function getEmployeeDetails(employeeId) {
	const [rows] = await safeQuery(
		`SELECT e.*, jl.job_level_name, p.position_name, d.department_name
     FROM mst_employee e
     LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
     LEFT JOIN mst_position p ON e.position_id = p.position_id
     LEFT JOIN mst_department d ON e.department_id = d.department_id
     WHERE e.employee_id = ? AND e.is_deleted = 0 LIMIT 1`,
		[employeeId]
	);
	return rows[0] || null;
}

async function getEmployeeMap(employeeIds) {
	const uniqueIds = [...new Set(employeeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();

	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name,
				e.department_id,
				p.position_name,
				j.job_level_name,
				d.department_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			LEFT JOIN mst_department d ON d.department_id = e.department_id
			WHERE e.is_deleted = 0
				AND e.employee_id IN (${placeholders})
		`,
		uniqueIds
	);

	const map = new Map();
	for (const row of rows) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
			department_name: row.department_name || "-",
			department_id: row.department_id,
		});
	}
	return map;
}

function formatTimeFromDate(value) {
	if (!value) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Jakarta",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(d);
	const hour = parts.find((p) => p.type === "hour")?.value || "00";
	const minute = parts.find((p) => p.type === "minute")?.value || "00";
	return `${hour}:${minute}`;
}

export const getLemburRoList = async (req, res) => {
	try {
		if (!req.session?.employeeId) {
			return res.status(400).json({ message: "Sesi karyawan tidak valid" });
		}

		const defaults = getDefaultCutoffRange();
		const startDate = toISODateString(req.query.startDate) || defaults.startDate;
		const endDate = toISODateString(req.query.endDate) || defaults.endDate;

		const statusFilter = String(req.query.status || "").trim();
		if (statusFilter && !ALLOWED_STATUSES.has(statusFilter)) {
			return res.status(400).json({
				message: "Status tidak valid. Gunakan: Pending_Supervisor, Pending_HRD, Rejected_Supervisor, Rejected_HRD, disetujui",
			});
		}

		// Modul form hanya tampilkan lembur (bukan replace_off historis)
		const requestTypeFilterRaw = String(req.query.requestType || "").toLowerCase();
		if (requestTypeFilterRaw && requestTypeFilterRaw !== "lembur" && !ALLOWED_REQUEST_TYPES.has(requestTypeFilterRaw)) {
			return res.status(400).json({ message: "Jenis tidak valid. Gunakan: lembur" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;
		const search = String(req.query.search || "").trim().slice(0, 100);

		const where = ["l.work_date >= ?", "l.work_date <= ?", "l.request_type = ?"];
		const params = [startDate, endDate, "lembur"];

		if (statusFilter) {
			where.push("l.status = ?");
			params.push(statusFilter);
		}
		if (search) {
			where.push("CAST(l.employee_id AS CHAR) LIKE ?");
			params.push(`%${search}%`);
		}

		const whereSql = where.join(" AND ");

		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_lembur_ro l WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeAloraMobileQuery(
			`
				SELECT
					l.id,
					l.employee_id,
					l.request_type,
					l.work_date,
					l.start_at,
					l.end_at,
					l.duration_hours,
					l.description,
					l.todo_items,
					l.compensation_type,
					l.replacement_date,
					l.status,
					l.department_id,
					l.supervisor_id,
					l.supervisor_approved_at,
					l.supervisor_rejection_reason,
					l.hrd_id,
					l.hrd_approved_at,
					l.hrd_rejection_reason,
					l.rejection_note,
					l.approved_by,
					l.approved_by_name,
					l.approved_at,
					l.created_at,
					l.updated_at
				FROM tr_worker_lembur_ro l
				WHERE ${whereSql}
				ORDER BY l.created_at DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const employeeIds = [
			...rows.map((r) => r.employee_id),
			...rows.map((r) => r.supervisor_id),
			...rows.map((r) => r.hrd_id),
		];
		const employeeMap = await getEmployeeMap(employeeIds);

		const records = rows.map((row) => {
			const empInfo = employeeMap.get(Number(row.employee_id)) || {};
			const spvInfo = employeeMap.get(Number(row.supervisor_id)) || {};
			const hrdInfo = employeeMap.get(Number(row.hrd_id)) || {};
			let todoItems = row.todo_items;
			if (typeof todoItems === "string") {
				try {
					todoItems = JSON.parse(todoItems);
				} catch {
					todoItems = null;
				}
			}
			if (!Array.isArray(todoItems)) todoItems = null;
			return {
				...row,
				work_date: toDateInput(row.work_date),
				replacement_date: row.replacement_date ? toDateInput(row.replacement_date) : null,
				start_time: formatTimeFromDate(row.start_at),
				end_time: formatTimeFromDate(row.end_at),
				duration_hours: row.duration_hours != null ? Number(row.duration_hours) : null,
				todo_items: todoItems,
				employee_name: empInfo.employee_name || `ID ${row.employee_id}`,
				jabatan: empInfo.jabatan || "-",
				department_name: empInfo.department_name || "-",
				supervisor_name: spvInfo.employee_name || null,
				hrd_name: hrdInfo.employee_name || row.approved_by_name || null,
			};
		});

		const [summaryRows] = await safeAloraMobileQuery(
			`SELECT status, COUNT(*) AS cnt FROM tr_worker_lembur_ro GROUP BY status`,
			[]
		);
		const statusCounts = {
			Pending_Supervisor: 0,
			Pending_HRD: 0,
			Rejected_Supervisor: 0,
			Rejected_HRD: 0,
			disetujui: 0,
		};
		for (const r of summaryRows) {
			if (r.status in statusCounts) statusCounts[r.status] = Number(r.cnt);
		}

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
			statusCounts,
			period: { startDate, endDate },
		});
	} catch (err) {
		console.error("[alora getLemburRoList] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data lembur & RO Alora" });
	}
};

export const approveSupervisor = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat memberikan persetujuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_lembur_ro WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
		if (item.status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status pengajuan tidak valid untuk persetujuan supervisor" });
		}
		if (Number(currentEmp.department_id) !== Number(item.department_id)) {
			return res.status(403).json({ message: "Anda hanya dapat menyetujui pengajuan dari departemen Anda sendiri" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_lembur_ro SET
				status = 'disetujui',
				supervisor_id = ?,
				supervisor_approved_at = NOW(),
				supervisor_rejection_reason = NULL,
				approved_by = ?,
				approved_by_name = ?,
				approved_at = NOW(),
				updated_at = NOW()
			 WHERE id = ?`,
			[currentEmpId, currentEmpId, currentEmp.full_name || null, id]
		);

		return res.json({ message: "Pengajuan lembur/RO berhasil disetujui." });
	} catch (err) {
		console.error("[alora lemburRo approveSupervisor] Error:", err);
		return res.status(500).json({ message: "Gagal melakukan approval supervisor" });
	}
};

export const rejectSupervisor = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const reason = String(req.body?.reason || "").trim().slice(0, 1000);
		if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat menolak pengajuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_lembur_ro WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
		if (item.status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status pengajuan tidak valid untuk ditolak oleh supervisor" });
		}
		if (Number(currentEmp.department_id) !== Number(item.department_id)) {
			return res.status(403).json({ message: "Anda hanya dapat menolak pengajuan dari departemen Anda sendiri" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_lembur_ro SET
				status = 'Rejected_Supervisor',
				supervisor_id = ?,
				supervisor_rejection_reason = ?,
				supervisor_approved_at = NULL,
				rejection_note = ?,
				updated_at = NOW()
			 WHERE id = ?`,
			[currentEmpId, reason, reason, id]
		);

		return res.json({ message: "Pengajuan berhasil ditolak oleh supervisor" });
	} catch (err) {
		console.error("[alora lemburRo rejectSupervisor] Error:", err);
		return res.status(500).json({ message: "Gagal melakukan penolakan supervisor" });
	}
};

export const approveHRD = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isHRDUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya HRD yang dapat melakukan tindakan ini" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_lembur_ro WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
		if (item.status !== "Pending_HRD") {
			return res.status(400).json({ message: "Status pengajuan tidak valid untuk persetujuan HRD" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_lembur_ro SET
				status = 'disetujui',
				hrd_id = ?,
				hrd_approved_at = NOW(),
				hrd_rejection_reason = NULL,
				rejection_note = NULL,
				approved_by = ?,
				approved_by_name = ?,
				approved_at = NOW(),
				updated_at = NOW()
			 WHERE id = ?`,
			[currentEmpId, currentEmpId, currentEmp.full_name || null, id]
		);

		return res.json({ message: "Pengajuan berhasil disetujui HRD" });
	} catch (err) {
		console.error("[alora lemburRo approveHRD] Error:", err);
		return res.status(500).json({ message: "Gagal melakukan approval HRD" });
	}
};

export const rejectHRD = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const reason = String(req.body?.reason || "").trim().slice(0, 1000);
		if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isHRDUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya HRD yang dapat menolak pengajuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_lembur_ro WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
		if (item.status !== "Pending_HRD") {
			return res.status(400).json({ message: "Status pengajuan tidak valid untuk ditolak oleh HRD" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_lembur_ro SET
				status = 'Rejected_HRD',
				hrd_id = ?,
				hrd_rejection_reason = ?,
				hrd_approved_at = NULL,
				rejection_note = ?,
				approved_by = ?,
				approved_by_name = ?,
				approved_at = NULL,
				updated_at = NOW()
			 WHERE id = ?`,
			[currentEmpId, reason, reason, currentEmpId, currentEmp.full_name || null, id]
		);

		return res.json({ message: "Pengajuan berhasil ditolak oleh HRD" });
	} catch (err) {
		console.error("[alora lemburRo rejectHRD] Error:", err);
		return res.status(500).json({ message: "Gagal melakukan penolakan HRD" });
	}
};
