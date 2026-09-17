import { safeAloraMobileQuery } from "../db/pool.js";

const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

export function jakartaWeekday(dateStr) {
	const d = new Date(`${dateStr}T12:00:00+07:00`);
	return d.getUTCDay();
}

export function todayDateStringJakarta() {
	const now = new Date();
	const utc = now.getTime() + now.getTimezoneOffset() * 60000;
	const jakarta = new Date(utc + JAKARTA_OFFSET_MS);
	return jakarta.toISOString().slice(0, 10);
}

export function addDaysDateString(dateStr, days) {
	const d = new Date(`${dateStr}T12:00:00+07:00`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

export async function isOffDay(dateStr) {
	const dow = jakartaWeekday(dateStr);
	const [holidayRows] = await safeAloraMobileQuery(
		`SELECT id FROM mst_holiday WHERE holiday_date = ? LIMIT 1`,
		[dateStr]
	);
	if (holidayRows[0]) return true;

	const [scheduleRows] = await safeAloraMobileQuery(
		`SELECT is_working_day FROM mst_work_schedule WHERE day_of_week = ? LIMIT 1`,
		[dow]
	);
	const schedule = scheduleRows[0];
	if (!schedule) return dow === 0;
	return Number(schedule.is_working_day) === 0;
}
