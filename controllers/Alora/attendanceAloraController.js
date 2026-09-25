import fs from "fs";
import path from "path";
import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";
import { ALORA_MOBILE_ATT_DIR, ALORA_MOBILE_BASE } from "../../middleware/upload.js";
import { getAloraMobileApiBaseUrl, proxyAloraMobileFile } from "../../utils/aloraMobileApiAssets.js";
import { resolveFinalStatus } from "../../utils/attendanceStatusResolver.js";

const ALLOWED_STATUS_LABELS = new Set([
	"Belum check-in",
	"Belum check-out",
	"Foto belum lengkap",
	"Lengkap",
]);

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function toPositiveIntList(value) {
	const raw = Array.isArray(value) ? value.join(",") : String(value || "");
	if (!raw.trim()) return [];
	const values = raw
		.split(",")
		.map((part) => Number(String(part).trim()))
		.filter((n) => Number.isInteger(n) && n > 0);
	return [...new Set(values)];
}

function toBoolean(value) {
	const v = String(value || "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

function toDateInput(date) {
	const d = new Date(date);
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function toDateOnlyJakarta(value) {
	if (value == null || value === "") return null;
	if (typeof value === "string") {
		const s = value.trim();
		if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
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

function toDateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) return toDateOnlyJakarta(value);
	return toDateOnlyJakarta(value) || String(value).slice(0, 10);
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

function todayDateStringJakarta() {
	return toDateOnlyJakarta(new Date()) || toDateInput(new Date());
}

function diffDays(startDate, endDate) {
	const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
	return Math.floor(ms / 86400000);
}

function hasPhotoValue(value) {
	return Boolean(value && String(value).trim());
}

function getRecordStatus(row) {
	const hasCheckIn = Boolean(row.clock_in);
	const hasCheckOut = Boolean(row.clock_out);
	const hasCheckInPhoto = hasPhotoValue(row.foto_masuk_path);
	const hasCheckOutPhoto = hasPhotoValue(row.foto_keluar_path);

	if (!hasCheckIn) return "Belum check-in";
	if (!hasCheckOut) return "Belum check-out";
	if (!hasCheckInPhoto || !hasCheckOutPhoto) return "Foto belum lengkap";
	return "Lengkap";
}

function incompleteSqlCondition() {
	return `
		NOT (
			clock_in IS NOT NULL
			AND clock_out IS NOT NULL
			AND foto_masuk_path IS NOT NULL
			AND foto_masuk_path <> ''
			AND foto_keluar_path IS NOT NULL
			AND foto_keluar_path <> ''
		)
	`;
}

function statusSqlCondition(statusLabel) {
	if (statusLabel === "Belum check-in") return "clock_in IS NULL";
	if (statusLabel === "Belum check-out") return "clock_in IS NOT NULL AND clock_out IS NULL";
	if (statusLabel === "Foto belum lengkap") {
		return `
			clock_in IS NOT NULL
			AND clock_out IS NOT NULL
			AND (
				foto_masuk_path IS NULL OR foto_masuk_path = ''
				OR foto_keluar_path IS NULL OR foto_keluar_path = ''
			)
		`;
	}
	if (statusLabel === "Lengkap") {
		return `
			clock_in IS NOT NULL
			AND clock_out IS NOT NULL
			AND foto_masuk_path IS NOT NULL AND foto_masuk_path <> ''
			AND foto_keluar_path IS NOT NULL AND foto_keluar_path <> ''
		`;
	}
	return null;
}

function getAttendanceDir() {
	if (ALORA_MOBILE_ATT_DIR) return ALORA_MOBILE_ATT_DIR;
	const legacy = process.env.ALORA_MOBILE_ATTENDANCE_DIR;
	if (!legacy) return null;
	return path.resolve(legacy);
}

function buildAttendancePhotoUrl(storedPath) {
	if (!storedPath) return null;
	if (/^https?:\/\//i.test(storedPath)) return storedPath;

	const fileName = path.basename(String(storedPath));
	if (!fileName || fileName === "." || fileName === "..") return null;

	if (getAloraMobileApiBaseUrl() || ALORA_MOBILE_BASE || process.env.ALORA_MOBILE_ATTENDANCE_DIR) {
		return `/alora/attendance/photos/${encodeURIComponent(fileName)}`;
	}

	const externalBase = (process.env.ALORA_MOBILE_ATTENDANCE_BASE_URL || "").replace(/\/+$/, "");
	if (externalBase) return `${externalBase}/${encodeURIComponent(fileName)}`;

	return null;
}

async function getEmployeeMap(employeeIds) {
	const uniqueIds = [...new Set(employeeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();

	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name,
				e.department_id,
				p.position_name,
				j.job_level_name,
				d.department_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			LEFT JOIN mst_department d ON d.department_id = e.department_id
			WHERE e.is_deleted = 0
				AND e.employee_id IN (${placeholders})
		`,
		uniqueIds
	);

	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_id: Number(row.employee_id),
			employee_code: row.employee_code || null,
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
			department_name: row.department_name || "-",
			department_id: row.department_id,
		});
	}
	return map;
}

async function getMatchedEmployeeIdsBySearch(search) {
	if (!search) return [];
	const kw = `%${search}%`;
	const [rows] = await safeQuery(
		`
			SELECT e.employee_id
			FROM mst_employee e
			WHERE e.is_deleted = 0
				AND (
					e.full_name LIKE ?
					OR e.employee_code LIKE ?
					OR CAST(e.employee_id AS CHAR) LIKE ?
				)
			LIMIT 2000
		`,
		[kw, kw, kw]
	);
	return (rows || [])
		.map((row) => Number(row.employee_id))
		.filter((id) => Number.isInteger(id) && id > 0);
}

async function fetchLemburHoursByDay(employeeIds, startDate, endDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	const placeholders = ids.map(() => "?").join(",");
	const [rows] = await safeAloraMobileQuery(
		`SELECT employee_id, work_date, SUM(duration_hours) AS lembur_hours
		 FROM tr_worker_lembur_ro
		 WHERE request_type = 'lembur' AND status = 'disetujui'
		   AND work_date >= ? AND work_date <= ?
		   AND employee_id IN (${placeholders})
		 GROUP BY employee_id, work_date`,
		[startDate, endDate, ...ids]
	);
	for (const row of rows || []) {
		const empId = Number(row.employee_id);
		const workDate = toDateOnly(row.work_date);
		if (!empId || !workDate) continue;
		map.set(`${empId}|${workDate}`, Number(row.lembur_hours) || 0);
	}
	return map;
}

async function fetchLemburTotalsByEmployee(employeeIds, startDate, endDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	const placeholders = ids.map(() => "?").join(",");
	const [rows] = await safeAloraMobileQuery(
		`SELECT employee_id,
		        SUM(duration_hours) AS total_lembur_hours,
		        COUNT(*) AS lembur_count
		 FROM tr_worker_lembur_ro
		 WHERE request_type = 'lembur' AND status = 'disetujui'
		   AND work_date >= ? AND work_date <= ?
		   AND employee_id IN (${placeholders})
		 GROUP BY employee_id`,
		[startDate, endDate, ...ids]
	);
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			total_lembur_hours: Number(row.total_lembur_hours) || 0,
			lembur_count: Number(row.lembur_count) || 0,
		});
	}
	return map;
}

async function fetchReplaceOffBalances(employeeIds) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	ids.forEach((id) => map.set(id, 0));

	const asOf = todayDateStringJakarta();
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
				lot.remaining = Math.round((lot.remaining - take) * 100) / 100;
				need = Math.round((need - take) * 100) / 100;
			}
		}
		let usable = 0;
		for (const lot of lots) {
			if (!lot.usableUntil || asOf > lot.usableUntil) continue;
			usable += lot.remaining;
		}
		map.set(empId, Math.max(0, Math.round(usable * 100) / 100));
	}
	return map;
}

async function fetchOvertimeBalances(employeeIds) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	ids.forEach((id) => map.set(id, 0));

	const period = dateToCutoffPeriod(todayDateStringJakarta());
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
		map.set(empId, Math.max(0, Math.round((earned - used) * 100) / 100));
	}
	return map;
}

async function fetchRoEarnedByEmployee(employeeIds, startDate, endDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	const where = [
		"l.mutation_type = 'earned'",
		`(
			(l.attendance_id IS NOT NULL AND a.attendance_date >= ? AND a.attendance_date <= ?)
			OR (l.attendance_id IS NULL AND DATE(l.created_at) >= ? AND DATE(l.created_at) <= ?)
		)`,
	];
	const params = [startDate, endDate, startDate, endDate];
	if (ids.length > 0) {
		where.push(`l.employee_id IN (${ids.map(() => "?").join(",")})`);
		params.push(...ids);
	}
	const [rows] = await safeAloraMobileQuery(
		`SELECT l.employee_id, SUM(l.hours) AS total_ro_earned_hours
		 FROM tr_replace_off_ledger l
		 LEFT JOIN tr_worker_attendance a ON a.id = l.attendance_id
		 WHERE ${where.join(" AND ")}
		 GROUP BY l.employee_id`,
		params
	);
	for (const row of rows || []) {
		const empId = Number(row.employee_id);
		if (!empId) continue;
		map.set(empId, Number(row.total_ro_earned_hours) || 0);
	}
	return map;
}

async function fetchIzinFundingTotalsByEmployee(employeeIds, startDate, endDate) {
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	const where = [
		"status = 'disetujui'",
		"leave_type = 'izin'",
		"start_date <= ?",
		"end_date >= ?",
	];
	const params = [endDate, startDate];
	if (ids.length > 0) {
		where.push(`employee_id IN (${ids.map(() => "?").join(",")})`);
		params.push(...ids);
	}
	const [rows] = await safeAloraMobileQuery(
		`SELECT employee_id,
		        COALESCE(SUM(funding_ro_hours), 0) AS izin_ro_hours,
		        COALESCE(SUM(funding_overtime_hours), 0) AS izin_overtime_hours,
		        COALESCE(SUM(funding_unpaid_hours), 0) AS izin_unpaid_hours
		 FROM tr_worker_leaves
		 WHERE ${where.join(" AND ")}
		 GROUP BY employee_id`,
		params
	);
	for (const row of rows || []) {
		const empId = Number(row.employee_id);
		if (!empId) continue;
		map.set(empId, {
			izin_ro_hours: Number(row.izin_ro_hours) || 0,
			izin_overtime_hours: Number(row.izin_overtime_hours) || 0,
			izin_unpaid_hours: Number(row.izin_unpaid_hours) || 0,
		});
	}
	return map;
}

function buildLemburSummaryRow({ empId, profile, lemburTot, roEarned, izinFunding, roBalance, overtimeBalance }) {
	return {
		employee_id: empId,
		employee_code: profile.employee_code || null,
		employee_name: profile.employee_name || `ID ${empId}`,
		jabatan: profile.jabatan || "-",
		total_lembur_hours: Number(lemburTot?.total_lembur_hours) || 0,
		lembur_count: Number(lemburTot?.lembur_count) || 0,
		total_ro_earned_hours: Number(roEarned) || 0,
		izin_ro_hours: Number(izinFunding?.izin_ro_hours) || 0,
		izin_overtime_hours: Number(izinFunding?.izin_overtime_hours) || 0,
		izin_unpaid_hours: Number(izinFunding?.izin_unpaid_hours) || 0,
		replace_off_hours: Number(roBalance) || 0,
		overtime_balance_hours: Number(overtimeBalance) || 0,
	};
}

function formatLeaveTimeHHmm(value) {
	if (value == null || value === "") return null;
	if (typeof value === "string") {
		const m = value.trim().match(/^(\d{1,2}):(\d{2})/);
		if (m) return `${String(m[1]).padStart(2, "0")}:${m[2]}`;
	}
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Jakarta",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(d);
	const hour = parts.find((p) => p.type === "hour")?.value || "00";
	const minute = parts.find((p) => p.type === "minute")?.value || "00";
	return `${hour}:${minute}`;
}

function formatLeaveFundingSummary(row) {
	if (String(row.leave_type || "").toLowerCase() !== "izin") return "-";
	const parts = [];
	const ro = Number(row.funding_ro_hours || 0);
	const ot = Number(row.funding_overtime_hours || 0);
	const unpaid = Number(row.funding_unpaid_hours || 0);
	if (ro > 0) parts.push(`RO ${ro}j`);
	if (ot > 0) parts.push(`Lembur ${ot}j`);
	if (unpaid > 0) parts.push(`Unpaid ${unpaid}j`);
	return parts.length > 0 ? parts.join(" + ") : "-";
}

async function fetchApprovedLeavesForExport({ startDate, endDate, employeeIds = [] }) {
	const where = ["status = 'disetujui'", "start_date <= ?", "end_date >= ?"];
	const params = [endDate, startDate];
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (ids.length > 0) {
		where.push(`employee_id IN (${ids.map(() => "?").join(",")})`);
		params.push(...ids);
	}
	const [rows] = await safeAloraMobileQuery(
		`SELECT id, employee_id, leave_type, duration_type, start_date, end_date, reason,
		        start_time, end_time,
		        funding_ro_hours, funding_overtime_hours, funding_unpaid_hours,
		        doctor_note_path, doctor_note_file
		 FROM tr_worker_leaves
		 WHERE ${where.join(" AND ")}
		 ORDER BY start_date ASC, id ASC
		 LIMIT 5000`,
		params
	);
	return rows || [];
}

async function fetchLemburRowsForExport({ startDate, endDate, employeeIds = [] }) {
	const where = ["request_type = 'lembur'", "status = 'disetujui'", "work_date >= ?", "work_date <= ?"];
	const params = [startDate, endDate];
	const ids = [...new Set((employeeIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (ids.length > 0) {
		where.push(`employee_id IN (${ids.map(() => "?").join(",")})`);
		params.push(...ids);
	}
	const [rows] = await safeAloraMobileQuery(
		`SELECT employee_id,
		        SUM(duration_hours) AS total_lembur_hours,
		        COUNT(*) AS lembur_count
		 FROM tr_worker_lembur_ro
		 WHERE ${where.join(" AND ")}
		 GROUP BY employee_id
		 ORDER BY total_lembur_hours DESC
		 LIMIT 5000`,
		params
	);
	return rows || [];
}

function buildWhereClause({ startDate, endDate, employeeId, employeeIds, matchedEmployeeIds, search, onlyIncomplete, statusFilter }) {
	const where = ["attendance_date BETWEEN ? AND ?"];
	const params = [startDate, endDate];

	if (employeeIds.length > 0) {
		where.push(`employee_id IN (${employeeIds.map(() => "?").join(",")})`);
		params.push(...employeeIds);
	} else if (employeeId) {
		where.push("employee_id = ?");
		params.push(employeeId);
	}

	if (search) {
		const searchParts = ["CAST(employee_id AS CHAR) LIKE ?"];
		const searchParams = [`%${search}%`];
		if (matchedEmployeeIds.length > 0) {
			searchParts.push(`employee_id IN (${matchedEmployeeIds.map(() => "?").join(",")})`);
			searchParams.push(...matchedEmployeeIds);
		}
		where.push(`(${searchParts.join(" OR ")})`);
		params.push(...searchParams);
	}

	if (onlyIncomplete) {
		where.push(incompleteSqlCondition());
	}

	if (statusFilter) {
		const statusSql = statusSqlCondition(statusFilter);
		if (statusSql) where.push(`(${statusSql})`);
	}

	return { whereSql: where.join(" AND "), params };
}

export const getAttendanceReport = async (req, res) => {
	try {
		const defaults = getDefaultCutoffRange();
		const startDate = toISODateString(req.query.startDate) || defaults.startDate;
		const endDate = toISODateString(req.query.endDate) || defaults.endDate;

		if (new Date(endDate) < new Date(startDate)) {
			return res.status(400).json({ message: "endDate tidak boleh lebih kecil dari startDate" });
		}
		if (diffDays(startDate, endDate) > 62) {
			return res.status(400).json({ message: "Range tanggal maksimal 63 hari" });
		}

		const employeeId = toPositiveInt(req.query.employeeId);
		if (req.query.employeeId && !employeeId) {
			return res.status(400).json({ message: "employeeId harus bilangan bulat positif" });
		}

		const employeeIds = toPositiveIntList(req.query.employeeIds);
		if (req.query.employeeIds && employeeIds.length === 0) {
			return res.status(400).json({ message: "employeeIds harus berisi bilangan bulat positif" });
		}
		if (employeeIds.length > 200) {
			return res.status(400).json({ message: "employeeIds maksimal 200 data" });
		}

		const search = String(req.query.search || "").trim().slice(0, 100);
		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(Math.max(toPositiveInt(req.query.limit) || 50, 1), 100000);
		const offset = (page - 1) * limit;
		const onlyIncomplete = toBoolean(req.query.onlyIncomplete);
		const includeExport = toBoolean(req.query.includeExport);
		const statusFilter = String(req.query.status || "").trim();
		if (statusFilter && !ALLOWED_STATUS_LABELS.has(statusFilter)) {
			return res.status(400).json({
				message: "Status tidak valid. Gunakan: Belum check-in, Belum check-out, Foto belum lengkap, Lengkap",
			});
		}

		const matchedEmployeeIds = await getMatchedEmployeeIdsBySearch(search);
		const { whereSql, params } = buildWhereClause({
			startDate,
			endDate,
			employeeId,
			employeeIds,
			matchedEmployeeIds,
			search,
			onlyIncomplete,
			statusFilter,
		});

		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_attendance WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeAloraMobileQuery(
			`
				SELECT
					id,
					employee_id,
					attendance_date,
					clock_in,
					clock_out,
					foto_masuk_path,
					foto_keluar_path,
					clock_in_latitude,
					clock_in_longitude,
					clock_out_latitude,
					clock_out_longitude,
					clock_in_location_name,
					clock_out_location_name,
					late_category,
					late_reason,
					late_minutes,
					late_status,
					clock_in_inside_radius,
					clock_out_inside_radius,
					attendance_mode,
					mode_request_id,
					punch_location_context_in,
					punch_location_context_out,
					mode_reason,
					duration_hours,
					approval_status,
					created_at,
					updated_at
				FROM tr_worker_attendance
				WHERE ${whereSql}
				ORDER BY attendance_date DESC, clock_in DESC, id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const [summaryRows] = await safeAloraMobileQuery(
			`
				SELECT
					COUNT(*) AS total_records,
					COUNT(DISTINCT employee_id) AS total_employees,
					SUM(CASE WHEN clock_in IS NOT NULL THEN 1 ELSE 0 END) AS checked_in_count,
					SUM(CASE WHEN clock_out IS NOT NULL THEN 1 ELSE 0 END) AS checked_out_count,
					SUM(
						CASE WHEN clock_in IS NOT NULL
							AND clock_out IS NOT NULL
							AND foto_masuk_path IS NOT NULL
							AND foto_masuk_path <> ''
							AND foto_keluar_path IS NOT NULL
							AND foto_keluar_path <> ''
						THEN 1 ELSE 0 END
					) AS complete_count,
					SUM(
						CASE WHEN NOT (
							clock_in IS NOT NULL
							AND clock_out IS NOT NULL
							AND foto_masuk_path IS NOT NULL
							AND foto_masuk_path <> ''
							AND foto_keluar_path IS NOT NULL
							AND foto_keluar_path <> ''
						) THEN 1 ELSE 0 END
					) AS incomplete_count
				FROM tr_worker_attendance
				WHERE ${whereSql}
			`,
			params
		);

		const [employeeSummaryRows] = await safeAloraMobileQuery(
			`
				SELECT
					employee_id,
					COUNT(*) AS record_count,
					SUM(
						CASE WHEN clock_in IS NOT NULL
							AND clock_out IS NOT NULL
							AND foto_masuk_path IS NOT NULL
							AND foto_masuk_path <> ''
							AND foto_keluar_path IS NOT NULL
							AND foto_keluar_path <> ''
						THEN 1 ELSE 0 END
					) AS complete_count,
					SUM(
						CASE WHEN NOT (
							clock_in IS NOT NULL
							AND clock_out IS NOT NULL
							AND foto_masuk_path IS NOT NULL
							AND foto_masuk_path <> ''
							AND foto_keluar_path IS NOT NULL
							AND foto_keluar_path <> ''
						) THEN 1 ELSE 0 END
					) AS incomplete_count
				FROM tr_worker_attendance
				WHERE ${whereSql}
				GROUP BY employee_id
				ORDER BY record_count DESC
				LIMIT 500
			`,
			params
		);

		const optionWhere = ["attendance_date BETWEEN ? AND ?"];
		const optionParams = [startDate, endDate];
		const [optionRows] = await safeAloraMobileQuery(
			`
				SELECT DISTINCT employee_id
				FROM tr_worker_attendance
				WHERE ${optionWhere.join(" AND ")}
				ORDER BY employee_id ASC
				LIMIT 3000
			`,
			optionParams
		);

		const allEmployeeIds = [
			...new Set([
				...(rows || []).map((r) => Number(r.employee_id)),
				...(employeeSummaryRows || []).map((r) => Number(r.employee_id)),
				...(optionRows || []).map((r) => Number(r.employee_id)),
			]),
		].filter((id) => Number.isInteger(id) && id > 0);

		const employeeMap = await getEmployeeMap(allEmployeeIds);

		const pageEmployeeIds = [
			...new Set((rows || []).map((r) => Number(r.employee_id)).filter((id) => Number.isInteger(id) && id > 0)),
		];
		let leaveRows = [];
		let sessionRows = [];
		let lemburByDay = new Map();
		if (pageEmployeeIds.length > 0) {
			const placeholders = pageEmployeeIds.map(() => "?").join(",");
			const [leaves] = await safeAloraMobileQuery(
				`SELECT employee_id, leave_type, start_date, end_date, status, doctor_note_path
				 FROM tr_worker_leaves
				 WHERE employee_id IN (${placeholders}) AND status = 'disetujui'
				   AND start_date <= ? AND end_date >= ?`,
				[...pageEmployeeIds, endDate, startDate]
			);
			const [sessions] = await safeAloraMobileQuery(
				`SELECT employee_id, session_type, work_date, status
				 FROM tr_attendance_sessions
				 WHERE employee_id IN (${placeholders}) AND work_date >= ? AND work_date <= ?`,
				[...pageEmployeeIds, startDate, endDate]
			);
			leaveRows = leaves || [];
			sessionRows = sessions || [];
			lemburByDay = await fetchLemburHoursByDay(pageEmployeeIds, startDate, endDate);
		}

		const summaryEmployeeIds = [
			...new Set((employeeSummaryRows || []).map((r) => Number(r.employee_id)).filter((id) => Number.isInteger(id) && id > 0)),
		];
		const lemburTotalsMap = await fetchLemburTotalsByEmployee(summaryEmployeeIds, startDate, endDate);
		const roBalanceMap = await fetchReplaceOffBalances(summaryEmployeeIds);
		const overtimeBalanceMap = await fetchOvertimeBalances(summaryEmployeeIds);
		const roEarnedMap = await fetchRoEarnedByEmployee(summaryEmployeeIds, startDate, endDate);
		const izinFundingMap = await fetchIzinFundingTotalsByEmployee(summaryEmployeeIds, startDate, endDate);

		const records = (rows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			const workDate = toDateOnly(row.attendance_date);
			const empId = Number(row.employee_id);
			const empLeaves = leaveRows.filter((l) => Number(l.employee_id) === empId);
			const empSessions = sessionRows.filter((s) => Number(s.employee_id) === empId);
			const finalStatus = resolveFinalStatus({
				date: workDate,
				attendance: row,
				leaves: empLeaves,
				sessions: empSessions,
			});
			const mode = row.attendance_mode || "regular";
			const ctxIn = row.punch_location_context_in || "remote";
			let modeLabel = "Harian";
			if (mode === "wfa") modeLabel = "WFA";
			else if (mode === "wod") modeLabel = ctxIn === "office" ? "WOD Office" : "WOD Remote";
			const lemburHours = lemburByDay.get(`${empId}|${workDate}`) || 0;
			return {
				attendance_id: Number(row.id),
				employee_id: empId,
				employee_code: profile.employee_code || null,
				employee_name: profile.employee_name || `ID ${row.employee_id}`,
				jabatan: profile.jabatan || "-",
				work_date: workDate,
				check_in_time: row.clock_in || null,
				check_out_time: row.clock_out || null,
				check_in_photo_url: buildAttendancePhotoUrl(row.foto_masuk_path),
				check_out_photo_url: buildAttendancePhotoUrl(row.foto_keluar_path),
				clock_in_latitude: row.clock_in_latitude ?? null,
				clock_in_longitude: row.clock_in_longitude ?? null,
				clock_out_latitude: row.clock_out_latitude ?? null,
				clock_out_longitude: row.clock_out_longitude ?? null,
				clock_in_location_name: row.clock_in_location_name || null,
				clock_out_location_name: row.clock_out_location_name || null,
				status_label: getRecordStatus(row),
				late_category: row.late_category || null,
				late_category_label:
					row.late_category === "planned"
						? "Terlambat Terencana"
						: row.late_category === "unexpected"
							? "Tidak Terencana"
							: (
								(row.late_minutes != null && Number(row.late_minutes) > 0)
								|| Boolean(String(row.late_reason || "").trim())
							)
								? "Terlambat"
								: null,
				late_reason: row.late_reason || null,
				late_minutes: row.late_minutes != null ? Number(row.late_minutes) : null,
				late_status: row.late_status || null,
				final_status: finalStatus.status_label,
				final_status_code: finalStatus.primary_status,
				late_flag: finalStatus.late_flag,
				approval_pending: finalStatus.approval_pending || false,
				attendance_mode: mode,
				mode_label: modeLabel,
				mode_request_id: row.mode_request_id != null ? Number(row.mode_request_id) : null,
				location_context: ctxIn === "office" ? "Office" : "Remote",
				duration_hours: row.duration_hours != null ? Number(row.duration_hours) : null,
				lembur_hours: lemburHours,
				approval_status: row.approval_status || null,
				mode_reason: row.mode_reason || null,
				clock_in_inside_radius: row.clock_in_inside_radius != null ? Boolean(row.clock_in_inside_radius) : null,
				clock_out_inside_radius: row.clock_out_inside_radius != null ? Boolean(row.clock_out_inside_radius) : null,
			};
		});

		const employeeSummary = (employeeSummaryRows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			const empId = Number(row.employee_id);
			const lemburTot = lemburTotalsMap.get(empId) || { total_lembur_hours: 0, lembur_count: 0 };
			const izinFunding = izinFundingMap.get(empId) || {
				izin_ro_hours: 0,
				izin_overtime_hours: 0,
				izin_unpaid_hours: 0,
			};
			return {
				employee_id: empId,
				employee_name: profile.employee_name || `ID ${row.employee_id}`,
				employee_code: profile.employee_code || null,
				jabatan: profile.jabatan || "-",
				record_count: Number(row.record_count || 0),
				complete_count: Number(row.complete_count || 0),
				incomplete_count: Number(row.incomplete_count || 0),
				total_lembur_hours: lemburTot.total_lembur_hours,
				lembur_count: lemburTot.lembur_count,
				total_ro_earned_hours: roEarnedMap.has(empId) ? roEarnedMap.get(empId) : 0,
				izin_ro_hours: izinFunding.izin_ro_hours,
				izin_overtime_hours: izinFunding.izin_overtime_hours,
				izin_unpaid_hours: izinFunding.izin_unpaid_hours,
				replace_off_hours: roBalanceMap.has(empId) ? roBalanceMap.get(empId) : 0,
				overtime_balance_hours: overtimeBalanceMap.has(empId) ? overtimeBalanceMap.get(empId) : 0,
			};
		});

		const employeeOptions = (optionRows || [])
			.map((row) => {
				const id = Number(row.employee_id);
				const profile = employeeMap.get(id) || {};
				return {
					employee_id: id,
					employee_code: profile.employee_code || null,
					employee_name: profile.employee_name || `ID ${id}`,
				};
			})
			.sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name), "id"));

		const summary = summaryRows?.[0] || {};

		let lemburSummary = [];
		let leavesIzinCuti = [];
		let leavesSakit = [];

		if (includeExport) {
			const exportEmpFilter = employeeId
				? [employeeId]
				: employeeIds.length > 0
					? employeeIds
					: matchedEmployeeIds.length > 0 && search
						? matchedEmployeeIds
						: [];

			const lemburAggRows = await fetchLemburRowsForExport({
				startDate,
				endDate,
				employeeIds: exportEmpFilter,
			});
			const lemburTotByEmp = new Map(
				lemburAggRows.map((r) => [
					Number(r.employee_id),
					{
						total_lembur_hours: Number(r.total_lembur_hours) || 0,
						lembur_count: Number(r.lembur_count) || 0,
					},
				])
			);

			const leaveRowsExport = await fetchApprovedLeavesForExport({
				startDate,
				endDate,
				employeeIds: exportEmpFilter,
			});

			const exportRoEarnedMap = await fetchRoEarnedByEmployee(exportEmpFilter, startDate, endDate);
			const exportIzinFundingMap = await fetchIzinFundingTotalsByEmployee(exportEmpFilter, startDate, endDate);

			const unionEmpIds = [
				...new Set([
					...lemburTotByEmp.keys(),
					...exportRoEarnedMap.keys(),
					...exportIzinFundingMap.keys(),
					...summaryEmployeeIds,
				]),
			].filter((id) => Number.isInteger(id) && id > 0);

			const filteredUnionEmpIds = unionEmpIds.filter((empId) => {
				const lemburTot = lemburTotByEmp.get(empId);
				const roEarned = Number(exportRoEarnedMap.get(empId) || 0);
				const izin = exportIzinFundingMap.get(empId) || {
					izin_ro_hours: 0,
					izin_overtime_hours: 0,
					izin_unpaid_hours: 0,
				};
				const hasLembur = (Number(lemburTot?.total_lembur_hours) || 0) > 0 || (Number(lemburTot?.lembur_count) || 0) > 0;
				const hasFunding =
					roEarned > 0
					|| Number(izin.izin_ro_hours) > 0
					|| Number(izin.izin_overtime_hours) > 0
					|| Number(izin.izin_unpaid_hours) > 0;
				return hasLembur || hasFunding;
			});

			const exportEmpMap = await getEmployeeMap([
				...new Set([
					...filteredUnionEmpIds,
					...leaveRowsExport.map((r) => Number(r.employee_id)).filter((id) => Number.isInteger(id) && id > 0),
				]),
			]);
			const exportRoMap = await fetchReplaceOffBalances(filteredUnionEmpIds);
			const exportOtMap = await fetchOvertimeBalances(filteredUnionEmpIds);

			lemburSummary = filteredUnionEmpIds
				.map((empId) => {
					const profile = exportEmpMap.get(empId) || employeeMap.get(empId) || {};
					return buildLemburSummaryRow({
						empId,
						profile,
						lemburTot: lemburTotByEmp.get(empId),
						roEarned: exportRoEarnedMap.get(empId) || 0,
						izinFunding: exportIzinFundingMap.get(empId),
						roBalance: exportRoMap.has(empId) ? exportRoMap.get(empId) : 0,
						overtimeBalance: exportOtMap.has(empId) ? exportOtMap.get(empId) : 0,
					});
				})
				.sort((a, b) => {
					const diff = Number(b.total_lembur_hours) - Number(a.total_lembur_hours);
					if (diff !== 0) return diff;
					return String(a.employee_name || "").localeCompare(String(b.employee_name || ""), "id");
				});

			for (const row of leaveRowsExport) {
				const empId = Number(row.employee_id);
				const profile = exportEmpMap.get(empId) || employeeMap.get(empId) || {};
				const leaveType = String(row.leave_type || "").toLowerCase();
				const base = {
					id: Number(row.id),
					employee_id: empId,
					employee_code: profile.employee_code || null,
					employee_name: profile.employee_name || `ID ${empId}`,
					jabatan: profile.jabatan || "-",
					leave_type: leaveType,
					duration_type: row.duration_type || null,
					start_date: toDateOnly(row.start_date),
					end_date: toDateOnly(row.end_date),
					start_time: formatLeaveTimeHHmm(row.start_time),
					end_time: formatLeaveTimeHHmm(row.end_time),
					reason: row.reason || null,
					funding_summary: formatLeaveFundingSummary(row),
					funding_ro_hours: Number(row.funding_ro_hours) || 0,
					funding_overtime_hours: Number(row.funding_overtime_hours) || 0,
					funding_unpaid_hours: Number(row.funding_unpaid_hours) || 0,
				};
				if (leaveType === "izin" || leaveType === "cuti") {
					leavesIzinCuti.push(base);
				} else if (leaveType === "sakit") {
					const hasNote = Boolean(
						(row.doctor_note_path && String(row.doctor_note_path).trim())
						|| (row.doctor_note_file && String(row.doctor_note_file).trim())
					);
					leavesSakit.push({
						...base,
						sakit_type: hasNote ? "SKD" : "Non-SKD",
					});
				}
			}
		}

		return res.json({
			success: true,
			filters: {
				startDate,
				endDate,
				employeeId: employeeId || null,
				employeeIds,
				search: search || null,
				onlyIncomplete,
				status: statusFilter || null,
				includeExport,
			},
			pagination: {
				total,
				page,
				limit,
				totalPages,
			},
			summary: {
				totalRecords: Number(summary.total_records || 0),
				totalEmployees: Number(summary.total_employees || 0),
				checkedInCount: Number(summary.checked_in_count || 0),
				checkedOutCount: Number(summary.checked_out_count || 0),
				completeCount: Number(summary.complete_count || 0),
				incompleteCount: Number(summary.incomplete_count || 0),
			},
			employeeOptions,
			employeeSummary,
			lemburSummary,
			leavesIzinCuti,
			leavesSakit,
			records,
			period: { startDate, endDate },
		});
	} catch (err) {
		console.error("[alora getAttendanceReport] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil report absensi Alora" });
	}
};

export const serveAttendancePhoto = async (req, res) => {
	try {
		const safeFileName = path.basename(String(req.params.filename || ""));
		if (!safeFileName || safeFileName === "." || safeFileName === "..") {
			return res.status(400).json({ success: false, message: "Nama file tidak valid" });
		}

		if (await proxyAloraMobileFile("attendance", safeFileName, res)) return;

		const dir = getAttendanceDir();
		if (!dir) {
			return res.status(500).json({
				success: false,
				message: "ALORA_MOBILE_API_BASE_URL / ALORA_MOBILE_UPLOAD_DIR belum dikonfigurasi",
			});
		}

		const fullPath = path.join(dir, safeFileName);
		const resolvedDir = path.resolve(dir);
		const resolvedFile = path.resolve(fullPath);
		if (!resolvedFile.startsWith(resolvedDir + path.sep) || !fs.existsSync(resolvedFile)) {
			return res.status(404).json({ success: false, message: "File absensi tidak ditemukan" });
		}

		res.setHeader("Cache-Control", "private, max-age=300");
		return res.sendFile(resolvedFile);
	} catch (error) {
		console.error("[alora serveAttendancePhoto]", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal menyajikan foto absensi Alora",
		});
	}
};
