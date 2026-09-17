import { safeAloraMobileQuery } from "../db/pool.js";

async function getReplaceOffBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_replace_off_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

export async function applyWodLedgerOnApprove(attendance) {
	if (!attendance || attendance.attendance_mode !== "wod") return null;

	const hours = Number(attendance.duration_hours || 0);
	if (hours <= 0) return null;

	const attendanceId = attendance.id;
	const employeeId = attendance.employee_id;

	const [existing] = await safeAloraMobileQuery(
		`SELECT id FROM tr_replace_off_ledger WHERE attendance_id = ? AND mutation_type = 'earned' LIMIT 1`,
		[attendanceId]
	);
	if (existing.length > 0) return null;

	const current = await getReplaceOffBalance(employeeId);
	const balanceAfter = Math.round((current + hours) * 100) / 100;

	await safeAloraMobileQuery(
		`INSERT INTO tr_replace_off_ledger (employee_id, attendance_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, 'earned', ?, ?, ?)`,
		[employeeId, attendanceId, hours, balanceAfter, `WOD disetujui #${attendanceId}`]
	);

	return { hours, balanceAfter };
}
