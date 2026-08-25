import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

const ALLOWED_SPORTS = new Set(["run", "cycle"]);

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

function parseHaidMode(value) {
	if (value === undefined || value === null || String(value).trim() === "") return null;
	const v = String(value).trim().toLowerCase();
	if (v === "1" || v === "true" || v === "yes") return 1;
	if (v === "0" || v === "false" || v === "no") return 0;
	return undefined;
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

function diffDays(startDate, endDate) {
	const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
	return Math.floor(ms / 86400000);
}

function toNumber(value, digits = 3) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	if (!Number.isFinite(n)) return null;
	return Math.round(n * 10 ** digits) / 10 ** digits;
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
				p.position_name,
				j.job_level_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			WHERE e.is_deleted = 0
				AND e.employee_id IN (${placeholders})
		`,
		uniqueIds
	);

	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_code: row.employee_code || null,
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
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

function buildWhereClause({
	startDate,
	endDate,
	employeeId,
	employeeIds,
	matchedEmployeeIds,
	search,
	sport,
	haidMode,
}) {
	const where = ["DATE(ended_at) BETWEEN ? AND ?"];
	const params = [startDate, endDate];

	if (employeeIds.length > 0) {
		where.push(`employee_id IN (${employeeIds.map(() => "?").join(",")})`);
		params.push(...employeeIds);
	} else if (employeeId) {
		where.push("employee_id = ?");
		params.push(employeeId);
	}

	if (search) {
		const searchParts = ["CAST(employee_id AS CHAR) LIKE ?", "employee_name LIKE ?"];
		const searchParams = [`%${search}%`, `%${search}%`];
		if (matchedEmployeeIds.length > 0) {
			searchParts.push(`employee_id IN (${matchedEmployeeIds.map(() => "?").join(",")})`);
			searchParams.push(...matchedEmployeeIds);
		}
		where.push(`(${searchParts.join(" OR ")})`);
		params.push(...searchParams);
	}

	if (sport) {
		where.push("sport = ?");
		params.push(sport);
	}

	if (haidMode === 0 || haidMode === 1) {
		where.push("haid_mode = ?");
		params.push(haidMode);
	}

	return { whereSql: where.join(" AND "), params };
}

export const getBugarReport = async (req, res) => {
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

		const sport = String(req.query.sport || "").trim().toLowerCase();
		if (sport && !ALLOWED_SPORTS.has(sport)) {
			return res.status(400).json({ message: "Sport tidak valid. Gunakan: run, cycle" });
		}

		const haidMode = parseHaidMode(req.query.haidMode);
		if (haidMode === undefined) {
			return res.status(400).json({ message: "haidMode tidak valid. Gunakan: 1 atau 0" });
		}

		const search = String(req.query.search || "").trim().slice(0, 100);
		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(Math.max(toPositiveInt(req.query.limit) || 50, 1), 100000);
		const offset = (page - 1) * limit;

		const matchedEmployeeIds = await getMatchedEmployeeIdsBySearch(search);
		const { whereSql, params } = buildWhereClause({
			startDate,
			endDate,
			employeeId,
			employeeIds,
			matchedEmployeeIds,
			search,
			sport,
			haidMode,
		});

		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_bugar_session WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeAloraMobileQuery(
			`
				SELECT
					id,
					employee_id,
					employee_name,
					sport,
					goal_focus,
					started_at,
					ended_at,
					duration_sec,
					distance_km,
					calories,
					avg_pace_or_speed,
					step_count,
					step_source,
					haid_mode,
					point_count
				FROM tr_worker_bugar_session
				WHERE ${whereSql}
				ORDER BY ended_at DESC, id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const [summaryRows] = await safeAloraMobileQuery(
			`
				SELECT
					COUNT(*) AS total_sessions,
					COUNT(DISTINCT employee_id) AS total_employees,
					COALESCE(SUM(distance_km), 0) AS total_km,
					COALESCE(SUM(calories), 0) AS total_calories,
					COALESCE(SUM(duration_sec), 0) AS total_duration_sec,
					SUM(CASE WHEN sport = 'run' THEN 1 ELSE 0 END) AS run_count,
					SUM(CASE WHEN sport = 'cycle' THEN 1 ELSE 0 END) AS cycle_count
				FROM tr_worker_bugar_session
				WHERE ${whereSql}
			`,
			params
		);

		const [employeeSummaryRows] = await safeAloraMobileQuery(
			`
				SELECT
					employee_id,
					COUNT(*) AS session_count,
					COALESCE(SUM(distance_km), 0) AS total_km,
					COALESCE(SUM(calories), 0) AS total_calories,
					COALESCE(SUM(duration_sec), 0) AS total_duration_sec
				FROM tr_worker_bugar_session
				WHERE ${whereSql}
				GROUP BY employee_id
				ORDER BY total_km DESC, session_count DESC
				LIMIT 500
			`,
			params
		);

		const [optionRows] = await safeAloraMobileQuery(
			`
				SELECT DISTINCT employee_id
				FROM tr_worker_bugar_session
				WHERE DATE(ended_at) BETWEEN ? AND ?
				ORDER BY employee_id ASC
				LIMIT 3000
			`,
			[startDate, endDate]
		);

		const allEmployeeIds = [
			...new Set([
				...(rows || []).map((r) => Number(r.employee_id)),
				...(employeeSummaryRows || []).map((r) => Number(r.employee_id)),
				...(optionRows || []).map((r) => Number(r.employee_id)),
			]),
		].filter((id) => Number.isInteger(id) && id > 0);

		const employeeMap = await getEmployeeMap(allEmployeeIds);

		const records = (rows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			return {
				session_id: Number(row.id),
				employee_id: Number(row.employee_id),
				employee_code: profile.employee_code || null,
				employee_name: profile.employee_name || row.employee_name || `ID ${row.employee_id}`,
				jabatan: profile.jabatan || "-",
				sport: row.sport || null,
				goal_focus: row.goal_focus || null,
				started_at: row.started_at || null,
				ended_at: row.ended_at || null,
				duration_sec: Number(row.duration_sec || 0),
				distance_km: toNumber(row.distance_km, 3),
				calories: Number(row.calories || 0),
				avg_pace_or_speed: toNumber(row.avg_pace_or_speed, 3),
				step_count: row.step_count == null ? null : Number(row.step_count),
				step_source: row.step_source || null,
				haid_mode: Boolean(row.haid_mode),
				point_count: Number(row.point_count || 0),
			};
		});

		const employeeSummary = (employeeSummaryRows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			return {
				employee_id: Number(row.employee_id),
				employee_name: profile.employee_name || `ID ${row.employee_id}`,
				employee_code: profile.employee_code || null,
				jabatan: profile.jabatan || "-",
				session_count: Number(row.session_count || 0),
				total_km: toNumber(row.total_km, 3) || 0,
				total_calories: Number(row.total_calories || 0),
				total_duration_sec: Number(row.total_duration_sec || 0),
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

		return res.json({
			success: true,
			filters: {
				startDate,
				endDate,
				employeeId: employeeId || null,
				employeeIds,
				search: search || null,
				sport: sport || null,
				haidMode,
			},
			pagination: {
				total,
				page,
				limit,
				totalPages,
			},
			summary: {
				totalSessions: Number(summary.total_sessions || 0),
				totalEmployees: Number(summary.total_employees || 0),
				totalKm: toNumber(summary.total_km, 1) || 0,
				totalCalories: Number(summary.total_calories || 0),
				totalDurationSec: Number(summary.total_duration_sec || 0),
				runCount: Number(summary.run_count || 0),
				cycleCount: Number(summary.cycle_count || 0),
			},
			employeeOptions,
			employeeSummary,
			records,
			period: { startDate, endDate },
		});
	} catch (err) {
		console.error("[alora getBugarReport] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil report Alora Bugar" });
	}
};
