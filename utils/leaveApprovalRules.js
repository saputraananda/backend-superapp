/**
 * Rules for leave approval branching (izin RO-only skips HRD).
 */

export function isRoOnlyIzin(leave) {
	if (!leave || leave.leave_type !== "izin") return false;
	const ro = Number(leave.funding_ro_hours || 0);
	const ot = Number(leave.funding_overtime_hours || 0);
	const unpaid = Number(leave.funding_unpaid_hours || 0);
	return ro > 0 && ot === 0 && unpaid === 0;
}
