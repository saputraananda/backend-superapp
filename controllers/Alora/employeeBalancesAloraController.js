import { safeQuery } from "../../db/pool.js";
import {
	appendAnnualLeaveLedger,
	computeLeaveCycleStart,
	getAnnualLeaveBalance,
	getEmployeeJoinDate,
} from "../../utils/annualLeaveService.js";
import {
	getOvertimeUsableBalancesMap,
	getReplaceOffUsableBalancesMap,
	setOvertimeUsableHours,
	setReplaceOffUsableHours,
} from "../../utils/otRoBalanceService.js";
import { todayDateStringJakarta } from "../../utils/workScheduleRules.js";

const HRD_POSITION_IDS = [1, 8, 17, 18, 19];

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function isHRDUser(employee) {
	if (!employee) return false;
	return HRD_POSITION_IDS.includes(Number(employee.position_id));
}

async function getEmployeeDetails(employeeId) {
	const [rows] = await safeQuery(
		`SELECT e.*, p.position_name, d.department_name
     FROM mst_employee e
     LEFT JOIN mst_position p ON e.position_id = p.position_id
     LEFT JOIN mst_department d ON e.department_id = d.department_id
     WHERE e.employee_id = ? AND e.is_deleted = 0 LIMIT 1`,
		[employeeId]
	);
	return rows[0] || null;
}

async function assertHrd(req) {
	const currentEmpId = req.session?.employeeId;
	if (!currentEmpId) {
		const error = new Error("Sesi karyawan tidak valid");
		error.statusCode = 400;
		throw error;
	}
	const currentEmp = await getEmployeeDetails(currentEmpId);
	if (!isHRDUser(currentEmp)) {
		const error = new Error("Hanya HRD yang dapat mengakses saldo karyawan");
		error.statusCode = 403;
		throw error;
	}
	return { currentEmpId, currentEmp };
}

function parseNote(body) {
	const note = String(body?.note || "").trim().slice(0, 500);
	if (note.length < 3) {
		const error = new Error("Catatan wajib diisi minimal 3 karakter");
		error.statusCode = 400;
		throw error;
	}
	return note;
}

export const listEmployeeBalances = async (req, res) => {
	try {
		await assertHrd(req);

		const search = String(req.query.search || "").trim();
		const page = Math.max(1, Number(req.query.page) || 1);
		let limit = Number(req.query.limit) || 20;
		if (![20, 50, 100].includes(limit)) limit = 20;
		const offset = (page - 1) * limit;

		const where = ["e.is_deleted = 0", "e.company_id = 1"];
		const params = [];
		if (search) {
			where.push(
				`(e.full_name LIKE ? OR e.employee_code LIKE ? OR CAST(e.employee_id AS CHAR) LIKE ?)`
			);
			const like = `%${search}%`;
			params.push(like, like, like);
		}

		const whereSql = where.join(" AND ");
		const [[countRow]] = await safeQuery(
			`SELECT COUNT(*) AS total
       FROM mst_employee e
       WHERE ${whereSql}`,
			params
		);
		const total = Number(countRow?.total) || 0;
		const totalPages = Math.max(1, Math.ceil(total / limit) || 1);

		const [employees] = await safeQuery(
			`SELECT e.employee_id, e.full_name, e.employee_code, d.department_name
       FROM mst_employee e
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE ${whereSql}
       ORDER BY e.full_name ASC
       LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);

		const ids = (employees || []).map((e) => Number(e.employee_id));
		const [otMap, roMap] = await Promise.all([
			getOvertimeUsableBalancesMap(ids),
			getReplaceOffUsableBalancesMap(ids),
		]);

		const items = [];
		for (const emp of employees || []) {
			const employeeId = Number(emp.employee_id);
			const annual = await getAnnualLeaveBalance(employeeId, todayDateStringJakarta());
			items.push({
				employee_id: employeeId,
				full_name: emp.full_name,
				employee_code: emp.employee_code,
				department_name: emp.department_name || null,
				annual_leave: {
					eligible: Boolean(annual?.eligible),
					balance_days: Number(annual?.balance_days) || 0,
					join_date: annual?.join_date || null,
					cycle_start: annual?.cycle_start || null,
					cycle_end: annual?.cycle_end || null,
				},
				overtime_hours: otMap.get(employeeId) ?? 0,
				replace_off_hours: roMap.get(employeeId) ?? 0,
			});
		}

		return res.json({
			items,
			pagination: { page, limit, total, totalPages },
		});
	} catch (err) {
		const status = err.statusCode || 500;
		if (status === 500) console.error("[alora listEmployeeBalances]", err);
		return res.status(status).json({ message: err.message || "Gagal memuat saldo karyawan" });
	}
};

export const setAnnualLeaveBalance = async (req, res) => {
	try {
		const { currentEmpId } = await assertHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) return res.status(400).json({ message: "employeeId tidak valid" });

		const days = Number(req.body?.days);
		if (!Number.isFinite(days) || days < 0 || days > 365) {
			return res.status(400).json({ message: "Nilai hari cuti tidak valid (0–365)" });
		}
		const note = parseNote(req.body);

		const targetEmp = await getEmployeeDetails(employeeId);
		if (!targetEmp) return res.status(404).json({ message: "Karyawan tidak ditemukan" });

		const joinDate = await getEmployeeJoinDate(employeeId);
		const cycleStart = computeLeaveCycleStart(joinDate, todayDateStringJakarta());
		if (!cycleStart) {
			return res.status(400).json({ message: "Karyawan belum berhak cuti tahunan" });
		}

		const balance = await getAnnualLeaveBalance(employeeId, todayDateStringJakarta());
		if (!balance?.eligible) {
			return res.status(400).json({ message: "Karyawan belum berhak cuti tahunan" });
		}

		const current = Number(balance.balance_days) || 0;
		const target = Math.round(days * 100) / 100;
		const delta = Math.round((target - current) * 100) / 100;

		let ledgerId = null;
		let balanceAfter = current;
		if (delta !== 0) {
			const result = await appendAnnualLeaveLedger({
				employeeId,
				cycleStart,
				mutationType: "hr_adjust",
				days: delta,
				note,
				createdBy: currentEmpId,
			});
			ledgerId = result.id;
			balanceAfter = result.balanceAfter;
		}

		const next = await getAnnualLeaveBalance(employeeId, todayDateStringJakarta());
		return res.json({
			message: delta === 0 ? "Saldo cuti tidak berubah" : "Saldo cuti berhasil diset",
			ledger_id: ledgerId,
			balance_after: balanceAfter,
			annual_leave: {
				eligible: Boolean(next?.eligible),
				balance_days: Number(next?.balance_days) || 0,
				join_date: next?.join_date || null,
				cycle_start: next?.cycle_start || null,
				cycle_end: next?.cycle_end || null,
			},
		});
	} catch (err) {
		const status = err.statusCode || 500;
		if (status === 500) console.error("[alora setAnnualLeaveBalance]", err);
		return res.status(status).json({ message: err.message || "Gagal set saldo cuti" });
	}
};

export const setOvertimeBalance = async (req, res) => {
	try {
		await assertHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) return res.status(400).json({ message: "employeeId tidak valid" });

		const hours = Number(req.body?.hours);
		if (!Number.isFinite(hours) || hours < 0 || hours > 999.99) {
			return res.status(400).json({ message: "Nilai jam lembur tidak valid (0–999.99)" });
		}
		const note = parseNote(req.body);

		const targetEmp = await getEmployeeDetails(employeeId);
		if (!targetEmp) return res.status(404).json({ message: "Karyawan tidak ditemukan" });

		const result = await setOvertimeUsableHours(employeeId, hours, note);
		return res.json({
			message: result.changed ? "Saldo lembur berhasil diset" : "Saldo lembur tidak berubah",
			ledger_id: result.ledger_id,
			overtime_hours: result.hours,
		});
	} catch (err) {
		const status = err.statusCode || 500;
		if (status === 500) console.error("[alora setOvertimeBalance]", err);
		return res.status(status).json({ message: err.message || "Gagal set saldo lembur" });
	}
};

export const setReplaceOffBalance = async (req, res) => {
	try {
		await assertHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) return res.status(400).json({ message: "employeeId tidak valid" });

		const hours = Number(req.body?.hours);
		if (!Number.isFinite(hours) || hours < 0 || hours > 999.99) {
			return res.status(400).json({ message: "Nilai jam RO tidak valid (0–999.99)" });
		}
		const note = parseNote(req.body);

		const targetEmp = await getEmployeeDetails(employeeId);
		if (!targetEmp) return res.status(404).json({ message: "Karyawan tidak ditemukan" });

		const result = await setReplaceOffUsableHours(employeeId, hours, note);
		return res.json({
			message: result.changed ? "Saldo RO berhasil diset" : "Saldo RO tidak berubah",
			ledger_id: result.ledger_id,
			replace_off_hours: result.hours,
		});
	} catch (err) {
		const status = err.statusCode || 500;
		if (status === 500) console.error("[alora setReplaceOffBalance]", err);
		return res.status(status).json({ message: err.message || "Gagal set saldo RO" });
	}
};
