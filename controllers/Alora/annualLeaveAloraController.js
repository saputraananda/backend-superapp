import { safeQuery } from "../../db/pool.js";
import {
	appendAnnualLeaveLedger,
	computeLeaveCycleStart,
	getAnnualLeaveBalance,
	getAnnualLeaveLedgerHistory,
	getEmployeeJoinDate,
} from "../../utils/annualLeaveService.js";
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

export const getEmployeeBalance = async (req, res) => {
	try {
		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isHRDUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya HRD yang dapat melihat saldo cuti" });
		}

		const employeeId = toPositiveInt(req.query.employeeId);
		if (!employeeId) return res.status(400).json({ message: "employeeId wajib diisi" });

		const targetEmp = await getEmployeeDetails(employeeId);
		if (!targetEmp) return res.status(404).json({ message: "Karyawan tidak ditemukan" });

		const balance = await getAnnualLeaveBalance(employeeId, todayDateStringJakarta());
		let ledger = [];
		if (balance.cycle_start) {
			ledger = await getAnnualLeaveLedgerHistory(employeeId, balance.cycle_start, 10);
		}

		return res.json({
			employee: {
				employee_id: targetEmp.employee_id,
				full_name: targetEmp.full_name,
				department_name: targetEmp.department_name,
			},
			balance,
			ledger,
		});
	} catch (err) {
		console.error("[alora getEmployeeBalance] Error:", err);
		return res.status(500).json({ message: "Gagal memuat saldo cuti" });
	}
};

export const adjustBalance = async (req, res) => {
	try {
		const currentEmpId = req.session?.employeeId;
		if (!currentEmpId) return res.status(400).json({ message: "Sesi karyawan tidak valid" });

		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isHRDUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya HRD yang dapat menyesuaikan saldo cuti" });
		}

		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) return res.status(400).json({ message: "ID karyawan tidak valid" });

		const days = Number(req.body?.days);
		if (!Number.isFinite(days) || days === 0) {
			return res.status(400).json({ message: "Nilai hari adjust wajib diisi (positif atau negatif)" });
		}

		const note = String(req.body?.note || "").trim().slice(0, 500);
		if (!note) return res.status(400).json({ message: "Catatan adjust wajib diisi" });

		const targetEmp = await getEmployeeDetails(employeeId);
		if (!targetEmp) return res.status(404).json({ message: "Karyawan tidak ditemukan" });

		const joinDate = await getEmployeeJoinDate(employeeId);
		const cycleStart = computeLeaveCycleStart(joinDate, todayDateStringJakarta());
		if (!cycleStart) {
			return res.status(400).json({ message: "Karyawan belum berhak cuti tahunan" });
		}

		const result = await appendAnnualLeaveLedger({
			employeeId,
			cycleStart,
			mutationType: "hr_adjust",
			days,
			note,
			createdBy: currentEmpId,
		});

		const balance = await getAnnualLeaveBalance(employeeId, todayDateStringJakarta());
		return res.json({
			message: "Saldo cuti berhasil disesuaikan",
			ledger_id: result.id,
			balance_after: result.balanceAfter,
			balance,
		});
	} catch (err) {
		console.error("[alora adjustBalance] Error:", err);
		return res.status(500).json({ message: "Gagal menyesuaikan saldo cuti" });
	}
};
