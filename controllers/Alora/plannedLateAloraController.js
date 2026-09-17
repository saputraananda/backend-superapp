import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

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
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function isSupervisorUser(employee) {
	if (!employee) return false;
	const level = Number(employee.job_level_id);
	return !Number.isNaN(level) && level <= 3;
}

async function getEmployeeDetails(employeeId) {
	const [rows] = await safeQuery(
		`SELECT e.*, d.department_name FROM mst_employee e
     LEFT JOIN mst_department d ON d.department_id = e.department_id
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
		`SELECT e.employee_id, e.full_name, d.department_name, e.department_id
     FROM mst_employee e
     LEFT JOIN mst_department d ON d.department_id = e.department_id
     WHERE e.is_deleted = 0 AND e.employee_id IN (${placeholders})`,
		uniqueIds
	);
	const map = new Map();
	for (const row of rows) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name,
			department_name: row.department_name || "-",
			department_id: row.department_id,
		});
	}
	return map;
}

function formatTimeFromDate(value) {
	if (!value) return null;
	const d = new Date(value);
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Jakarta",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(d);
	return `${parts.find((p) => p.type === "hour")?.value || "00"}:${parts.find((p) => p.type === "minute")?.value || "00"}`;
}

export const getPlannedLateList = async (req, res) => {
	try {
		const defaults = getDefaultCutoffRange();
		const startDate = toISODateString(req.query.startDate) || defaults.startDate;
		const endDate = toISODateString(req.query.endDate) || defaults.endDate;
		const statusFilter = String(req.query.status || "Pending_Supervisor").trim();

		const where = [
			"a.attendance_date >= ?",
			"a.attendance_date <= ?",
			"a.late_category = 'planned'",
		];
		const params = [startDate, endDate];

		if (statusFilter) {
			where.push("a.late_status = ?");
			params.push(statusFilter);
		}

		const [rows] = await safeAloraMobileQuery(
			`SELECT a.* FROM tr_worker_attendance a WHERE ${where.join(" AND ")} ORDER BY a.attendance_date DESC`,
			params
		);

		const employeeMap = await getEmployeeMap(rows.map((r) => r.employee_id));
		const records = rows.map((row) => {
			const emp = employeeMap.get(Number(row.employee_id)) || {};
			return {
				...row,
				attendance_date: toDateInput(row.attendance_date),
				clock_in_time: formatTimeFromDate(row.clock_in),
				employee_name: emp.employee_name || `ID ${row.employee_id}`,
				department_name: emp.department_name || "-",
			};
		});

		return res.json({ records, period: { startDate, endDate } });
	} catch (err) {
		console.error("[alora getPlannedLateList]", err);
		return res.status(500).json({ message: "Gagal mengambil data terlambat rencana" });
	}
};

export const approvePlannedLate = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.attendanceId);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const currentEmpId = req.session?.employeeId;
		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat memberikan persetujuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_attendance WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Record absensi tidak ditemukan" });
		if (item.late_category !== "planned" || item.late_status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status tidak valid untuk persetujuan terlambat rencana" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_attendance SET
        late_status = 'disetujui',
        late_supervisor_id = ?,
        late_supervisor_approved_at = NOW(),
        late_supervisor_rejection_reason = NULL,
        updated_at = NOW()
       WHERE id = ?`,
			[currentEmpId, id]
		);

		return res.json({ message: "Terlambat rencana disetujui." });
	} catch (err) {
		console.error("[alora approvePlannedLate]", err);
		return res.status(500).json({ message: "Gagal menyetujui terlambat rencana" });
	}
};

export const rejectPlannedLate = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.attendanceId);
		const reason = String(req.body?.reason || "").trim().slice(0, 1000);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });
		if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

		const currentEmpId = req.session?.employeeId;
		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat menolak" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_attendance WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Record absensi tidak ditemukan" });

		await safeAloraMobileQuery(
			`UPDATE tr_worker_attendance SET
        late_status = 'Rejected_Supervisor',
        late_supervisor_id = ?,
        late_supervisor_rejection_reason = ?,
        updated_at = NOW()
       WHERE id = ?`,
			[currentEmpId, reason, id]
		);

		return res.json({ message: "Terlambat rencana ditolak." });
	} catch (err) {
		console.error("[alora rejectPlannedLate]", err);
		return res.status(500).json({ message: "Gagal menolak terlambat rencana" });
	}
};
