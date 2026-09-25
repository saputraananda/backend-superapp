import { safeAloraMobileQuery } from "../db/pool.js";
import { todayDateStringJakarta } from "./workScheduleRules.js";

function toDateOnlyJakarta(value) {
	if (!value) return null;
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Jakarta",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(d);
}

function buildPeriodRange(month, year) {
	if (!(month >= 1 && month <= 12 && year >= 2000)) return null;
	const prevMonth = month === 1 ? 12 : month - 1;
	const prevYear = month === 1 ? year - 1 : year;
	return {
		periodStart: `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`,
		periodEnd: `${year}-${String(month).padStart(2, "0")}-25`,
	};
}

function dateToCutoffPeriod(dateStr) {
	const s = toDateOnlyJakarta(dateStr) || String(dateStr || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
	const y = Number(s.slice(0, 4));
	const m = Number(s.slice(5, 7));
	const d = Number(s.slice(8, 10));
	let month = m;
	let year = y;
	if (d >= 26) {
		month = m === 12 ? 1 : m + 1;
		year = m === 12 ? y + 1 : y;
	}
	const range = buildPeriodRange(month, year);
	if (!range) return null;
	return { month, year, periodStart: range.periodStart, periodEnd: range.periodEnd };
}

function shiftCutoffPeriod({ month, year }, deltaMonths = 0) {
	const m0 = Number(month);
	const y0 = Number(year);
	if (!(m0 >= 1 && m0 <= 12 && y0 >= 2000)) return null;
	const total = y0 * 12 + (m0 - 1) + Number(deltaMonths || 0);
	const newYear = Math.floor(total / 12);
	const newMonth = (total % 12) + 1;
	if (newYear < 2000) return null;
	const range = buildPeriodRange(newMonth, newYear);
	if (!range) return null;
	return { month: newMonth, year: newYear, periodStart: range.periodStart, periodEnd: range.periodEnd };
}

function roundHours(value) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

async function getOvertimeRunningBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_overtime_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

async function getReplaceOffRunningBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_replace_off_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

export async function getOvertimeUsableBalance(employeeId, asOfDate) {
	const asOf = toDateOnlyJakarta(asOfDate) || todayDateStringJakarta();
	const period = dateToCutoffPeriod(asOf);
	if (!period) return 0;

	const [earnedRows] = await safeAloraMobileQuery(
		`SELECT COALESCE(SUM(l.hours), 0) AS total
     FROM tr_overtime_ledger l
     LEFT JOIN tr_attendance_sessions s ON s.id = l.session_id
     WHERE l.employee_id = ?
       AND l.mutation_type = 'earned'
       AND COALESCE(DATE(s.work_date), DATE(l.created_at)) >= ?
       AND COALESCE(DATE(s.work_date), DATE(l.created_at)) <= ?`,
		[employeeId, period.periodStart, period.periodEnd]
	);
	const [usedRows] = await safeAloraMobileQuery(
		`SELECT COALESCE(SUM(l.hours), 0) AS total
     FROM tr_overtime_ledger l
     LEFT JOIN tr_worker_leaves lv ON lv.id = l.leave_id
     WHERE l.employee_id = ?
       AND l.mutation_type = 'used'
       AND COALESCE(DATE(lv.start_date), DATE(l.created_at)) >= ?
       AND COALESCE(DATE(lv.start_date), DATE(l.created_at)) <= ?`,
		[employeeId, period.periodStart, period.periodEnd]
	);

	const earned = Number(earnedRows[0]?.total) || 0;
	const used = Number(usedRows[0]?.total) || 0;
	return Math.max(0, roundHours(earned - used));
}

export async function getReplaceOffUsableBalance(employeeId, asOfDate) {
	const asOf = toDateOnlyJakarta(asOfDate) || todayDateStringJakarta();

	const [earnedRows] = await safeAloraMobileQuery(
		`SELECT l.id, l.hours,
            COALESCE(a.attendance_date, DATE(l.created_at)) AS earn_date
     FROM tr_replace_off_ledger l
     LEFT JOIN tr_worker_attendance a ON a.id = l.attendance_id
     WHERE l.employee_id = ?
       AND l.mutation_type = 'earned'
     ORDER BY l.id ASC`,
		[employeeId]
	);
	const [usedRows] = await safeAloraMobileQuery(
		`SELECT l.id, l.hours
     FROM tr_replace_off_ledger l
     WHERE l.employee_id = ?
       AND l.mutation_type = 'used'
     ORDER BY l.id ASC`,
		[employeeId]
	);

	const lots = (earnedRows || []).map((row) => {
		const earnDate = toDateOnlyJakarta(row.earn_date);
		const earnPeriod = dateToCutoffPeriod(earnDate);
		const untilPeriod = earnPeriod ? shiftCutoffPeriod(earnPeriod, 3) : null;
		return {
			remaining: Math.max(0, Number(row.hours) || 0),
			usableUntil: untilPeriod?.periodEnd || null,
		};
	});

	for (const used of usedRows || []) {
		let need = Math.max(0, Number(used.hours) || 0);
		for (const lot of lots) {
			if (need <= 0) break;
			if (lot.remaining <= 0) continue;
			const take = Math.min(lot.remaining, need);
			lot.remaining = roundHours(lot.remaining - take);
			need = roundHours(need - take);
		}
	}

	let usable = 0;
	for (const lot of lots) {
		if (!lot.usableUntil || asOf > lot.usableUntil) continue;
		usable += lot.remaining;
	}
	return Math.max(0, roundHours(usable));
}

export async function getOvertimeUsableBalancesMap(employeeIds, asOfDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	ids.forEach((id) => map.set(id, 0));

	const asOf = toDateOnlyJakarta(asOfDate) || todayDateStringJakarta();
	const period = dateToCutoffPeriod(asOf);
	if (!period) return map;

	const placeholders = ids.map(() => "?").join(",");
	const [earnedRows] = await safeAloraMobileQuery(
		`SELECT l.employee_id, COALESCE(SUM(l.hours), 0) AS total
     FROM tr_overtime_ledger l
     LEFT JOIN tr_attendance_sessions s ON s.id = l.session_id
     WHERE l.employee_id IN (${placeholders})
       AND l.mutation_type = 'earned'
       AND COALESCE(DATE(s.work_date), DATE(l.created_at)) >= ?
       AND COALESCE(DATE(s.work_date), DATE(l.created_at)) <= ?
     GROUP BY l.employee_id`,
		[...ids, period.periodStart, period.periodEnd]
	);
	const [usedRows] = await safeAloraMobileQuery(
		`SELECT l.employee_id, COALESCE(SUM(l.hours), 0) AS total
     FROM tr_overtime_ledger l
     LEFT JOIN tr_worker_leaves lv ON lv.id = l.leave_id
     WHERE l.employee_id IN (${placeholders})
       AND l.mutation_type = 'used'
       AND COALESCE(DATE(lv.start_date), DATE(l.created_at)) >= ?
       AND COALESCE(DATE(lv.start_date), DATE(l.created_at)) <= ?
     GROUP BY l.employee_id`,
		[...ids, period.periodStart, period.periodEnd]
	);

	const earnedMap = new Map();
	for (const row of earnedRows || []) {
		earnedMap.set(Number(row.employee_id), Number(row.total) || 0);
	}
	const usedMap = new Map();
	for (const row of usedRows || []) {
		usedMap.set(Number(row.employee_id), Number(row.total) || 0);
	}
	for (const empId of ids) {
		const earned = earnedMap.get(empId) || 0;
		const used = usedMap.get(empId) || 0;
		map.set(empId, Math.max(0, roundHours(earned - used)));
	}
	return map;
}

export async function getReplaceOffUsableBalancesMap(employeeIds, asOfDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	ids.forEach((id) => map.set(id, 0));

	const asOf = toDateOnlyJakarta(asOfDate) || todayDateStringJakarta();
	const placeholders = ids.map(() => "?").join(",");
	const [earnedRows] = await safeAloraMobileQuery(
		`SELECT l.employee_id, l.id, l.hours,
            COALESCE(a.attendance_date, DATE(l.created_at)) AS earn_date
     FROM tr_replace_off_ledger l
     LEFT JOIN tr_worker_attendance a ON a.id = l.attendance_id
     WHERE l.employee_id IN (${placeholders})
       AND l.mutation_type = 'earned'
     ORDER BY l.employee_id ASC, l.id ASC`,
		ids
	);
	const [usedRows] = await safeAloraMobileQuery(
		`SELECT l.employee_id, l.id, l.hours
     FROM tr_replace_off_ledger l
     WHERE l.employee_id IN (${placeholders})
       AND l.mutation_type = 'used'
     ORDER BY l.employee_id ASC, l.id ASC`,
		ids
	);

	const lotsByEmp = new Map();
	for (const row of earnedRows || []) {
		const empId = Number(row.employee_id);
		const earnDate = toDateOnlyJakarta(row.earn_date);
		const earnPeriod = dateToCutoffPeriod(earnDate);
		const untilPeriod = earnPeriod ? shiftCutoffPeriod(earnPeriod, 3) : null;
		if (!lotsByEmp.has(empId)) lotsByEmp.set(empId, []);
		lotsByEmp.get(empId).push({
			remaining: Math.max(0, Number(row.hours) || 0),
			usableUntil: untilPeriod?.periodEnd || null,
		});
	}

	const usedByEmp = new Map();
	for (const row of usedRows || []) {
		const empId = Number(row.employee_id);
		if (!usedByEmp.has(empId)) usedByEmp.set(empId, []);
		usedByEmp.get(empId).push(Math.max(0, Number(row.hours) || 0));
	}

	for (const empId of ids) {
		const lots = lotsByEmp.get(empId) || [];
		for (const hours of usedByEmp.get(empId) || []) {
			let need = hours;
			for (const lot of lots) {
				if (need <= 0) break;
				if (lot.remaining <= 0) continue;
				const take = Math.min(lot.remaining, need);
				lot.remaining = roundHours(lot.remaining - take);
				need = roundHours(need - take);
			}
		}
		let usable = 0;
		for (const lot of lots) {
			if (!lot.usableUntil || asOf > lot.usableUntil) continue;
			usable += lot.remaining;
		}
		map.set(empId, Math.max(0, roundHours(usable)));
	}
	return map;
}

export async function appendOvertimeLedger({
	employeeId,
	sessionId = null,
	leaveId = null,
	mutationType,
	hours,
	note = null,
}) {
	const current = await getOvertimeRunningBalance(employeeId);
	const amount = Math.abs(Number(hours));
	const delta = mutationType === "used" ? -amount : amount;
	const balanceAfter = roundHours(current + delta);
	const [result] = await safeAloraMobileQuery(
		`INSERT INTO tr_overtime_ledger
       (employee_id, session_id, leave_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[employeeId, sessionId, leaveId, mutationType, amount, balanceAfter, note]
	);
	return { id: result.insertId, balanceAfter };
}

export async function appendReplaceOffLedger({
	employeeId,
	sessionId = null,
	leaveId = null,
	attendanceId = null,
	mutationType,
	hours,
	note = null,
}) {
	const current = await getReplaceOffRunningBalance(employeeId);
	const amount = Math.abs(Number(hours));
	const delta = mutationType === "used" ? -amount : amount;
	const balanceAfter = roundHours(current + delta);
	const [result] = await safeAloraMobileQuery(
		`INSERT INTO tr_replace_off_ledger
       (employee_id, session_id, leave_id, attendance_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[employeeId, sessionId, leaveId, attendanceId, mutationType, amount, balanceAfter, note]
	);
	return { id: result.insertId, balanceAfter };
}

export async function setOvertimeUsableHours(employeeId, targetHours, note) {
	const target = roundHours(targetHours);
	const current = await getOvertimeUsableBalance(employeeId);
	const delta = roundHours(target - current);
	if (delta === 0) {
		return { changed: false, hours: current, ledger_id: null };
	}
	const mutationType = delta > 0 ? "earned" : "used";
	const result = await appendOvertimeLedger({
		employeeId,
		mutationType,
		hours: Math.abs(delta),
		note,
	});
	const hours = await getOvertimeUsableBalance(employeeId);
	return { changed: true, hours, ledger_id: result.id, balance_after: result.balanceAfter };
}

export async function setReplaceOffUsableHours(employeeId, targetHours, note) {
	const target = roundHours(targetHours);
	const current = await getReplaceOffUsableBalance(employeeId);
	const delta = roundHours(target - current);
	if (delta === 0) {
		return { changed: false, hours: current, ledger_id: null };
	}
	const mutationType = delta > 0 ? "earned" : "used";
	const result = await appendReplaceOffLedger({
		employeeId,
		mutationType,
		hours: Math.abs(delta),
		note,
	});
	const hours = await getReplaceOffUsableBalance(employeeId);
	return { changed: true, hours, ledger_id: result.id, balance_after: result.balanceAfter };
}
