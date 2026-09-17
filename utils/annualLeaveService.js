import { safeAloraMobileQuery, safeQuery } from "../db/pool.js";
import { addDaysDateString, isOffDay, todayDateStringJakarta } from "./workScheduleRules.js";

const ANNUAL_GRANT_DAYS = 12;
const PENDING_STATUSES = ["Pending_Supervisor", "Pending_HRD"];

function toDateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return String(value).slice(0, 10);
}

export function addYearsDateString(dateStr, years) {
	const d = new Date(`${dateStr}T12:00:00+07:00`);
	d.setUTCFullYear(d.getUTCFullYear() + years);
	return d.toISOString().slice(0, 10);
}

export function computeLeaveCycleStart(joinDate, asOfDate) {
	const join = toDateOnly(joinDate);
	const asOf = toDateOnly(asOfDate);
	if (!join || !asOf) return null;

	const firstEligible = addYearsDateString(join, 1);
	if (asOf < firstEligible) return null;

	const [, jm, jd] = join.split("-");
	const [ay] = asOf.split("-").map(Number);
	let cycleYear = ay;
	let anniv = `${cycleYear}-${jm}-${jd}`;
	if (anniv > asOf) {
		cycleYear -= 1;
		anniv = `${cycleYear}-${jm}-${jd}`;
	}
	return anniv;
}

export function computeNextAnniversary(joinDate, asOfDate) {
	const join = toDateOnly(joinDate);
	const asOf = toDateOnly(asOfDate);
	if (!join || !asOf) return null;

	const firstEligible = addYearsDateString(join, 1);
	if (asOf < firstEligible) return firstEligible;

	const cycleStart = computeLeaveCycleStart(join, asOf);
	if (!cycleStart) return firstEligible;
	return addYearsDateString(cycleStart, 1);
}

export async function getEmployeeJoinDate(employeeId) {
	const [rows] = await safeQuery(
		`SELECT join_date FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.join_date ? toDateOnly(rows[0].join_date) : null;
}

export function isAnnualLeaveEligible(joinDate, asOfDate) {
	return computeLeaveCycleStart(joinDate, asOfDate) !== null;
}

export async function countLeaveDays({ startDate, endDate, durationType }) {
	const start = toDateOnly(startDate);
	const end = toDateOnly(endDate);
	if (!start || !end || start > end) return 0;

	if (durationType !== "full_day") {
		if (await isOffDay(start)) return 0;
		return 0.5;
	}

	let total = 0;
	for (let d = start; d <= end; d = addDaysDateString(d, 1)) {
		if (!(await isOffDay(d))) total += 1;
	}
	return total;
}

async function getCycleLedgerBalance(employeeId, cycleStart) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_annual_leave_ledger
     WHERE employee_id = ? AND leave_cycle_start = ?
     ORDER BY id DESC LIMIT 1`,
		[employeeId, cycleStart]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

export async function ensureCycleGrant(employeeId, cycleStart) {
	const [existingRows] = await safeAloraMobileQuery(
		`SELECT id FROM tr_annual_leave_ledger
     WHERE employee_id = ? AND leave_cycle_start = ? AND mutation_type = 'granted'
     LIMIT 1`,
		[employeeId, cycleStart]
	);
	if (existingRows[0]) return;

	await safeAloraMobileQuery(
		`INSERT INTO tr_annual_leave_ledger
       (employee_id, leave_cycle_start, mutation_type, days, balance_after, note)
     VALUES (?, ?, 'granted', ?, ?, 'Grant otomatis cuti tahunan')`,
		[employeeId, cycleStart, ANNUAL_GRANT_DAYS, ANNUAL_GRANT_DAYS]
	);
}

async function sumPendingLeaveDays(employeeId, cycleStart, cycleEnd, excludeLeaveId = null) {
	const params = [employeeId, ...PENDING_STATUSES, cycleEnd, cycleStart];
	let excludeSql = "";
	if (excludeLeaveId) {
		excludeSql = " AND id <> ?";
		params.push(excludeLeaveId);
	}

	const [rows] = await safeAloraMobileQuery(
		`SELECT id, leave_days, duration_type, start_date, end_date
     FROM tr_worker_leaves
     WHERE employee_id = ?
       AND leave_type = 'cuti'
       AND status IN (?, ?)
       AND start_date <= ?
       AND end_date >= ?
       ${excludeSql}`,
		params
	);

	let total = 0;
	for (const row of rows) {
		if (row.leave_days != null) {
			total += Number(row.leave_days);
		} else {
			total += await countLeaveDays({
				startDate: row.start_date,
				endDate: row.end_date,
				durationType: row.duration_type,
			});
		}
	}
	return Math.round(total * 100) / 100;
}

async function sumUsedLeaveDays(employeeId, cycleStart) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT COALESCE(SUM(days), 0) AS total FROM tr_annual_leave_ledger
     WHERE employee_id = ? AND leave_cycle_start = ? AND mutation_type = 'used'`,
		[employeeId, cycleStart]
	);
	return Number(rows[0]?.total || 0);
}

export async function getAnnualLeaveBalance(employeeId, asOfDate = todayDateStringJakarta(), excludeLeaveId = null) {
	const joinDate = await getEmployeeJoinDate(employeeId);
	const cycleStart = joinDate ? computeLeaveCycleStart(joinDate, asOfDate) : null;
	const eligible = Boolean(cycleStart);

	if (!eligible) {
		return {
			eligible: false,
			join_date: joinDate,
			cycle_start: null,
			cycle_end: null,
			granted_days: 0,
			used_days: 0,
			pending_days: 0,
			balance_days: 0,
			next_anniversary: joinDate ? computeNextAnniversary(joinDate, asOfDate) : null,
		};
	}

	await ensureCycleGrant(employeeId, cycleStart);
	const cycleEnd = addDaysDateString(addYearsDateString(cycleStart, 1), -1);
	const ledgerBalance = await getCycleLedgerBalance(employeeId, cycleStart);
	const pendingDays = await sumPendingLeaveDays(employeeId, cycleStart, cycleEnd, excludeLeaveId);
	const usedDays = await sumUsedLeaveDays(employeeId, cycleStart);
	const balanceDays = Math.round((ledgerBalance - pendingDays) * 100) / 100;

	return {
		eligible: true,
		join_date: joinDate,
		cycle_start: cycleStart,
		cycle_end: cycleEnd,
		granted_days: ANNUAL_GRANT_DAYS,
		used_days: usedDays,
		pending_days: pendingDays,
		balance_days: balanceDays,
		next_anniversary: computeNextAnniversary(joinDate, asOfDate),
	};
}

export async function appendAnnualLeaveLedger({
	employeeId,
	cycleStart,
	leaveId = null,
	mutationType,
	days,
	note = null,
	createdBy = null,
}) {
	const current = await getCycleLedgerBalance(employeeId, cycleStart);
	let delta = Math.abs(Number(days));
	if (mutationType === "used") delta = -delta;
	else if (mutationType === "hr_adjust") delta = Number(days);
	else if (mutationType === "restored") delta = Math.abs(Number(days));
	else if (mutationType === "granted") delta = Math.abs(Number(days));

	const balanceAfter = Math.round((current + delta) * 100) / 100;
	const [result] = await safeAloraMobileQuery(
		`INSERT INTO tr_annual_leave_ledger
       (employee_id, leave_cycle_start, leave_id, mutation_type, days, balance_after, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			employeeId,
			cycleStart,
			leaveId,
			mutationType,
			Math.abs(Number(days)),
			balanceAfter,
			note,
			createdBy,
		]
	);
	return { id: result.insertId, balanceAfter };
}

export async function getAnnualLeaveLedgerHistory(employeeId, cycleStart, limit = 10) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT id, leave_cycle_start, leave_id, mutation_type, days, balance_after, note, created_by, created_at
     FROM tr_annual_leave_ledger
     WHERE employee_id = ? AND leave_cycle_start = ?
     ORDER BY id DESC
     LIMIT ?`,
		[employeeId, cycleStart, limit]
	);
	return rows;
}

export async function deductAnnualLeaveForApprovedLeave(leave) {
	if (leave.leave_type !== "cuti") return null;

	const [existingRows] = await safeAloraMobileQuery(
		`SELECT id FROM tr_annual_leave_ledger WHERE leave_id = ? AND mutation_type = 'used' LIMIT 1`,
		[leave.id]
	);
	if (existingRows[0]) return null;

	const leaveDays =
		leave.leave_days != null
			? Number(leave.leave_days)
			: await countLeaveDays({
					startDate: leave.start_date,
					endDate: leave.end_date,
					durationType: leave.duration_type,
				});

	if (leaveDays <= 0) return null;

	const joinDate = await getEmployeeJoinDate(leave.employee_id);
	const cycleStart = computeLeaveCycleStart(joinDate, toDateOnly(leave.start_date));
	if (!cycleStart) {
		const error = new Error("Karyawan belum berhak cuti tahunan pada tanggal pengajuan");
		error.statusCode = 400;
		throw error;
	}

	await ensureCycleGrant(leave.employee_id, cycleStart);
	return appendAnnualLeaveLedger({
		employeeId: leave.employee_id,
		cycleStart,
		leaveId: leave.id,
		mutationType: "used",
		days: leaveDays,
		note: `Cuti disetujui #${leave.id}`,
	});
}
