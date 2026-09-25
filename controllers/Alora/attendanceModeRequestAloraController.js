import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

const ALLOWED_STATUSES = new Set(["Pending_Supervisor", "disetujui", "Rejected_Supervisor"]);
const ALLOWED_TYPES = new Set(["wfa", "wod"]);

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

function toDateOnly(value) {
	if (!value) return null;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return toDateInput(d);
}

function statusLabel(status) {
	if (status === "disetujui") return "Disetujui";
	if (status === "Rejected_Supervisor") return "Ditolak";
	if (status === "Pending_Supervisor") return "Menunggu Approval";
	return status || "Status";
}

async function getEmployeeMap(employeeIds) {
	const uniqueIds = [...new Set(employeeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();
	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`SELECT e.employee_id, e.full_name, e.employee_code, d.department_name
     FROM mst_employee e
     LEFT JOIN mst_department d ON d.department_id = e.department_id
     WHERE e.is_deleted = 0 AND e.employee_id IN (${placeholders})`,
		uniqueIds
	);
	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), row);
	}
	return map;
}

export const listModeRequests = async (req, res) => {
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
				message: "Status tidak valid. Gunakan: Pending_Supervisor, Rejected_Supervisor, disetujui",
			});
		}

		const typeFilter = String(req.query.requestType || req.query.mode || "")
			.trim()
			.toLowerCase();
		if (typeFilter && !ALLOWED_TYPES.has(typeFilter)) {
			return res.status(400).json({ message: "Tipe tidak valid. Gunakan: wfa, wod" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;
		const search = String(req.query.search || "").trim().slice(0, 100);

		const where = ["work_date >= ?", "work_date <= ?"];
		const params = [startDate, endDate];

		if (statusFilter) {
			where.push("status = ?");
			params.push(statusFilter);
		}
		if (typeFilter) {
			where.push("request_type = ?");
			params.push(typeFilter);
		}
		if (search) {
			where.push("CAST(employee_id AS CHAR) LIKE ?");
			params.push(`%${search}%`);
		}

		const whereSql = where.join(" AND ");
		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_attendance_mode_requests WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit) || 1);

		const [rows] = await safeAloraMobileQuery(
			`SELECT id, employee_id, request_type, work_date, reason, status,
              supervisor_id, supervisor_approved_at, supervisor_rejection_reason, created_at
       FROM tr_attendance_mode_requests
       WHERE ${whereSql}
       ORDER BY work_date DESC, id DESC
       LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);

		const empMap = await getEmployeeMap((rows || []).map((r) => r.employee_id));
		const records = (rows || []).map((row) => {
			const emp = empMap.get(Number(row.employee_id));
			return {
				id: Number(row.id),
				employee_id: Number(row.employee_id),
				employee_name: emp?.full_name || null,
				employee_code: emp?.employee_code || null,
				department_name: emp?.department_name || null,
				request_type: row.request_type,
				work_date: toDateOnly(row.work_date),
				reason: row.reason || "",
				status: row.status,
				status_label: statusLabel(row.status),
				supervisor_rejection_reason: row.supervisor_rejection_reason || null,
				created_at: row.created_at,
			};
		});

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
		});
	} catch (err) {
		console.error("[alora listModeRequests]", err);
		return res.status(500).json({ message: "Gagal memuat pengajuan WFA/WOD" });
	}
};
