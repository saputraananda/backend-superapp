import { safeAloraMobileQuery } from "../db/pool.js";

async function getOvertimeBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_overtime_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

async function getReplaceOffBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_replace_off_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

async function appendOvertimeUsed({ employeeId, leaveId, hours, note }) {
	const current = await getOvertimeBalance(employeeId);
	const balanceAfter = Math.round((current - Math.abs(Number(hours))) * 100) / 100;
	await safeAloraMobileQuery(
		`INSERT INTO tr_overtime_ledger (employee_id, leave_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, 'used', ?, ?, ?)`,
		[employeeId, leaveId, Math.abs(Number(hours)), balanceAfter, note]
	);
	return balanceAfter;
}

async function appendReplaceOffUsed({ employeeId, leaveId, hours, note }) {
	const current = await getReplaceOffBalance(employeeId);
	const balanceAfter = Math.round((current - Math.abs(Number(hours))) * 100) / 100;
	await safeAloraMobileQuery(
		`INSERT INTO tr_replace_off_ledger (employee_id, leave_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, 'used', ?, ?, ?)`,
		[employeeId, leaveId, Math.abs(Number(hours)), balanceAfter, note]
	);
	return balanceAfter;
}

export async function applyLeaveFundingOnApprove(leave) {
	if (!leave || leave.leave_type !== "izin") return null;

	const roHours = Number(leave.funding_ro_hours || 0);
	const otHours = Number(leave.funding_overtime_hours || 0);
	if (roHours <= 0 && otHours <= 0) return null;

	const employeeId = leave.employee_id;
	const leaveId = leave.id;

	const [[existingRo]] = await safeAloraMobileQuery(
		`SELECT id FROM tr_replace_off_ledger WHERE leave_id = ? AND mutation_type = 'used' LIMIT 1`,
		[leaveId]
	);
	const [[existingOt]] = await safeAloraMobileQuery(
		`SELECT id FROM tr_overtime_ledger WHERE leave_id = ? AND mutation_type = 'used' LIMIT 1`,
		[leaveId]
	);
	if (existingRo || existingOt) return null;

	if (roHours > 0) {
		await appendReplaceOffUsed({
			employeeId,
			leaveId,
			hours: roHours,
			note: `Izin disetujui #${leaveId}`,
		});
	}
	if (otHours > 0) {
		await appendOvertimeUsed({
			employeeId,
			leaveId,
			hours: otHours,
			note: `Izin disetujui #${leaveId}`,
		});
	}

	return { roHours, otHours };
}
