import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const ALLOWED_SHIFTS = new Set(["pagi", "siang", "sore", "lembur"]);
const IKM_COMPANY_ID = 2;
const ADMIN_EMPLOYEE_ID = 31;
const ATTENDANCE_WATCH_INTERVAL_MS = 2000;
const SSE_KEEPALIVE_MS = 25000;

const attendanceSseClients = new Set();
let attendanceWatcherTimer = null;
let attendanceWatcherBusy = false;
let attendanceLastSignature = null;

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toBoolean(value) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "y"].includes(String(value || "").toLowerCase());
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

function diffDays(startDate, endDate) {
	const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
	return Math.floor(ms / 86400000);
}

function joinUrl(base, suffix) {
	const cleanBase = String(base || "").replace(/\/+$/, "");
	const cleanSuffix = String(suffix || "").replace(/^\/+/, "");
	if (!cleanBase) return `/${cleanSuffix}`;
	if (!cleanSuffix) return cleanBase;
	return `${cleanBase}/${cleanSuffix}`;
}

function buildPhotoUrl(photoPath, photoName) {
	if (!photoName) return null;
	if (/^https?:\/\//i.test(photoName)) return photoName;

	const encodedName = encodeURIComponent(photoName);
	const configuredBase = process.env.IKM_PHOTO_BASE_URL;
	const publicBase = (process.env.IKM_PUBLIC_BASE_URL || "https://api.ikmalora.com").replace(/\/+$/, "");

	if (configuredBase) {
		return joinUrl(configuredBase, encodedName);
	}

	if (photoPath && /^https?:\/\//i.test(photoPath)) {
		return joinUrl(photoPath, encodedName);
	}

	if (photoPath) {
		const withPublic = joinUrl(publicBase, String(photoPath).replace(/^\/+/, ""));
		return joinUrl(withPublic, encodedName);
	}

	return joinUrl(`${publicBase}/storage/buktiabsen`, encodedName);
}

function getRecordStatus(row) {
	const hasCheckIn = Boolean(row.check_in_time);
	const hasCheckOut = Boolean(row.check_out_time);
	const hasCheckInPhoto = Boolean(row.check_in_photo_name);
	const hasCheckOutPhoto = Boolean(row.check_out_photo_name);

	if (!hasCheckIn) return "Belum check-in";
	if (!hasCheckOut) return "Belum check-out";
	if (!hasCheckInPhoto || !hasCheckOutPhoto) return "Foto belum lengkap";
	return "Lengkap";
}

async function getMatchedEmployeeIdsBySearch(search) {
	if (!search) return [];
	const kw = `%${search}%`;
	const [rows] = await safeQuery(
		`
			SELECT e.employee_id
			FROM mst_employee e
			WHERE e.is_deleted = 0
				AND (e.company_id = ? OR e.employee_id = ?)
				AND (
					e.full_name LIKE ?
					OR e.employee_code LIKE ?
					OR CAST(e.employee_id AS CHAR) LIKE ?
				)
			LIMIT 2000
		`,
		[IKM_COMPANY_ID, ADMIN_EMPLOYEE_ID, kw, kw, kw]
	);
	return rows
		.map((row) => Number(row.employee_id))
		.filter((id) => Number.isInteger(id) && id > 0);
}

function buildWhereSql({ startDate, endDate, shiftType, employeeId, employeeIds, onlyIncomplete, search, matchedEmployeeIds }) {
	const where = ["work_date BETWEEN ? AND ?"];
	const params = [startDate, endDate];

	if (employeeIds.length > 0) {
		where.push(`employee_id IN (${employeeIds.map(() => "?").join(",")})`);
		params.push(...employeeIds);
	} else if (employeeId) {
		where.push("employee_id = ?");
		params.push(employeeId);
	}

	if (shiftType) {
		where.push("shift_type = ?");
		params.push(shiftType);
	}

	if (search) {
		const searchParts = ["CAST(employee_id AS CHAR) LIKE ?", "CAST(user_id AS CHAR) LIKE ?"];
		const searchParams = [`%${search}%`, `%${search}%`];

		if (matchedEmployeeIds.length > 0) {
			searchParts.push(`employee_id IN (${matchedEmployeeIds.map(() => "?").join(",")})`);
			searchParams.push(...matchedEmployeeIds);
		}

		where.push(`(${searchParts.join(" OR ")})`);
		params.push(...searchParams);
	}

	if (onlyIncomplete) {
		where.push(`
			NOT (
				check_in_time IS NOT NULL
				AND check_out_time IS NOT NULL
				AND check_in_photo_name IS NOT NULL
				AND check_in_photo_name <> ''
				AND check_out_photo_name IS NOT NULL
				AND check_out_photo_name <> ''
			)
		`);
	}

	return {
		whereSql: where.join(" AND "),
		params,
	};
}

function buildTodayWhereSql({ employeeId, employeeIds, shiftType, search, matchedEmployeeIds }) {
	const where = ["work_date = CURDATE()"];
	const params = [];

	if (employeeIds.length > 0) {
		where.push(`employee_id IN (${employeeIds.map(() => "?").join(",")})`);
		params.push(...employeeIds);
	} else if (employeeId) {
		where.push("employee_id = ?");
		params.push(employeeId);
	}

	if (shiftType) {
		where.push("shift_type = ?");
		params.push(shiftType);
	}

	if (search) {
		const searchParts = ["CAST(employee_id AS CHAR) LIKE ?", "CAST(user_id AS CHAR) LIKE ?"];
		const searchParams = [`%${search}%`, `%${search}%`];
		if (matchedEmployeeIds.length > 0) {
			searchParts.push(`employee_id IN (${matchedEmployeeIds.map(() => "?").join(",")})`);
			searchParams.push(...matchedEmployeeIds);
		}
		where.push(`(${searchParts.join(" OR ")})`);
		params.push(...searchParams);
	}

	return {
		whereSql: where.join(" AND "),
		params,
	};
}

async function getEmployeeSelectionOptions() {
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name
			FROM mst_employee e
			WHERE e.is_deleted = 0
				AND (e.company_id = ? OR e.employee_id = ?)
			ORDER BY e.full_name ASC
			LIMIT 3000
		`,
		[IKM_COMPANY_ID, ADMIN_EMPLOYEE_ID]
	);

	return rows.map((row) => ({
		employee_id: Number(row.employee_id),
		employee_code: row.employee_code || null,
		employee_name: row.full_name || `ID ${row.employee_id}`,
	}));
}

async function getEmployeeProfileMap(employeeIds) {
	if (!employeeIds.length) return new Map();

	const placeholders = employeeIds.map(() => "?").join(",");
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
		[...employeeIds]
	);

	const map = new Map();
	for (const row of rows) {
		map.set(Number(row.employee_id), {
			employee_code: row.employee_code || null,
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
		});
	}
	return map;
}

async function getLeaderRoleMap(employeeIds) {
	if (!employeeIds.length) return new Map();
	const placeholders = employeeIds.map(() => "?").join(",");
	const [rows] = await safeIKMQuery(
		`SELECT employee_id, role FROM mst_leader WHERE employee_id IN (${placeholders})`,
		[...employeeIds]
	);
	const map = new Map();
	for (const row of rows) {
		map.set(Number(row.employee_id), row.role);
	}
	return map;
}

function getEmployeeView(employeeMap, employeeId) {
	const profile = employeeMap.get(Number(employeeId));
	return {
		employee_code: profile?.employee_code || null,
		employee_name: profile?.employee_name || `ID ${employeeId}`,
		jabatan: profile?.jabatan || "-",
	};
}

function writeSseEvent(res, event, data) {
	res.write(`event: ${event}\n`);
	res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastAttendanceEvent(event, data) {
	for (const client of attendanceSseClients) {
		try {
			writeSseEvent(client, event, data);
		} catch {
			// Ignore client write error. Connection cleanup happens on close.
		}
	}
}

async function getAttendanceDataSignature() {
	const [rows] = await safeIKMQuery(
		`
			SELECT
				COALESCE(MAX(shift_record_id), 0) AS max_id,
				COALESCE(UNIX_TIMESTAMP(MAX(created_at)), 0) AS max_created_at,
				COALESCE(UNIX_TIMESTAMP(MAX(check_in_time)), 0) AS max_check_in,
				COALESCE(UNIX_TIMESTAMP(MAX(check_out_time)), 0) AS max_check_out,
				COUNT(*) AS total_rows
			FROM tr_attendance_shift_ikm
		`,
		[]
	);

	const row = rows?.[0] || {};
	return [
		Number(row.max_id || 0),
		Number(row.max_created_at || 0),
		Number(row.max_check_in || 0),
		Number(row.max_check_out || 0),
		Number(row.total_rows || 0),
	].join(":");
}

async function runAttendanceWatcherTick() {
	if (attendanceWatcherBusy || attendanceSseClients.size === 0) return;
	attendanceWatcherBusy = true;

	try {
		const nextSignature = await getAttendanceDataSignature();

		if (attendanceLastSignature === null) {
			attendanceLastSignature = nextSignature;
			return;
		}

		if (nextSignature !== attendanceLastSignature) {
			attendanceLastSignature = nextSignature;
			broadcastAttendanceEvent("attendance_update", {
				timestamp: new Date().toISOString(),
			});
		}
	} catch (error) {
		console.error("[attendanceSSEWatcher] Error:", error);
	} finally {
		attendanceWatcherBusy = false;
	}
}

function ensureAttendanceWatcher() {
	if (attendanceWatcherTimer) return;

	runAttendanceWatcherTick();
	attendanceWatcherTimer = setInterval(runAttendanceWatcherTick, ATTENDANCE_WATCH_INTERVAL_MS);
}

function stopAttendanceWatcherIfIdle() {
	if (attendanceSseClients.size > 0) return;
	if (attendanceWatcherTimer) {
		clearInterval(attendanceWatcherTimer);
		attendanceWatcherTimer = null;
	}
	attendanceLastSignature = null;
	attendanceWatcherBusy = false;
}

export const streamAttendanceShiftIKM = async (req, res) => {
	res.setHeader("Content-Type", "text/event-stream");
	res.setHeader("Cache-Control", "no-cache, no-transform");
	res.setHeader("Connection", "keep-alive");
	res.setHeader("X-Accel-Buffering", "no");
	res.flushHeaders?.();

	writeSseEvent(res, "connected", {
		message: "IKM attendance realtime stream connected",
		timestamp: new Date().toISOString(),
	});

	attendanceSseClients.add(res);
	ensureAttendanceWatcher();

	const keepAliveTimer = setInterval(() => {
		res.write(`: keep-alive ${Date.now()}\n\n`);
	}, SSE_KEEPALIVE_MS);

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(keepAliveTimer);
		attendanceSseClients.delete(res);
		stopAttendanceWatcherIfIdle();
	};

	req.on("close", close);
	req.on("end", close);
	res.on("close", close);
};

export const getAttendanceShiftIKM = async (req, res) => {
	try {
		const today = new Date().toISOString().slice(0, 10);
		const startDate = toISODateString(req.query.startDate) || today;
		const endDate = toISODateString(req.query.endDate) || startDate;

		if (new Date(endDate) < new Date(startDate)) {
			return res.status(400).json({ message: "endDate tidak boleh lebih kecil dari startDate" });
		}

		const rangeDays = diffDays(startDate, endDate);
		if (rangeDays > 62) {
			return res.status(400).json({ message: "Range tanggal maksimal 63 hari" });
		}

		const shiftType = String(req.query.shiftType || "").toLowerCase();
		if (shiftType && !ALLOWED_SHIFTS.has(shiftType)) {
			return res.status(400).json({ message: "shiftType tidak valid" });
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

		const search = String(req.query.search || "").trim();

		const page = Math.max(Number(req.query.page) || 1, 1);
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000000000000000);
		const offset = (page - 1) * limit;
		const onlyIncomplete = toBoolean(req.query.onlyIncomplete);

		const matchedEmployeeIds = await getMatchedEmployeeIdsBySearch(search);

		const { whereSql, params } = buildWhereSql({
			startDate,
			endDate,
			shiftType,
			employeeId,
			employeeIds,
			onlyIncomplete,
			search,
			matchedEmployeeIds,
		});

		const [countRows] = await safeIKMQuery(
			`SELECT COUNT(*) AS total FROM tr_attendance_shift_ikm WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows[0]?.total || 0);

		const [rows] = await safeIKMQuery(
			`
				SELECT
					shift_record_id,
					user_id,
					employee_id,
					work_date,
					shift_type,
					check_in_time,
					check_in_lat,
					check_in_lng,
					check_in_photo_path,
					check_in_photo_name,
					check_out_time,
					check_out_lat,
					check_out_lng,
					check_out_photo_path,
					check_out_photo_name,
					is_valet,
					created_at
				FROM tr_attendance_shift_ikm
				WHERE ${whereSql}
				ORDER BY
					check_in_time DESC,
					shift_record_id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const [summaryRows] = await safeIKMQuery(
			`
				SELECT
					COUNT(*) AS total_records,
					COUNT(DISTINCT employee_id) AS total_employees,
					SUM(CASE WHEN check_in_time IS NOT NULL THEN 1 ELSE 0 END) AS total_check_in,
					SUM(CASE WHEN check_out_time IS NOT NULL THEN 1 ELSE 0 END) AS total_check_out,
					SUM(
						CASE WHEN check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
						THEN 1 ELSE 0 END
					) AS total_time_complete,
					SUM(
						CASE WHEN check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						THEN 1 ELSE 0 END
					) AS total_photo_complete,
					SUM(
						CASE WHEN check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						THEN 1 ELSE 0 END
					) AS total_full_complete,
					SUM(CASE WHEN check_out_time IS NULL THEN 1 ELSE 0 END) AS pending_checkout,
					SUM(CASE WHEN check_in_time IS NULL THEN 1 ELSE 0 END) AS pending_checkin
				FROM tr_attendance_shift_ikm
				WHERE ${whereSql}
			`,
			params
		);

		const [dailyRows] = await safeIKMQuery(
			`
				SELECT
					employee_id,
					work_date,
					MAX(CASE WHEN shift_type = 'pagi' THEN 1 ELSE 0 END) AS has_pagi,
					MAX(CASE WHEN shift_type = 'siang' THEN 1 ELSE 0 END) AS has_siang,
					MAX(CASE WHEN shift_type = 'sore' THEN 1 ELSE 0 END) AS has_sore,
					MAX(CASE WHEN shift_type = 'lembur' THEN 1 ELSE 0 END) AS has_lembur,
					MAX(CASE WHEN shift_type = 'pagi'
						AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
						AND check_in_photo_name IS NOT NULL AND check_in_photo_name <> ''
						AND check_out_photo_name IS NOT NULL AND check_out_photo_name <> ''
					THEN 1 ELSE 0 END) AS pagi_complete,
					MAX(CASE WHEN shift_type = 'siang'
						AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
						AND check_in_photo_name IS NOT NULL AND check_in_photo_name <> ''
						AND check_out_photo_name IS NOT NULL AND check_out_photo_name <> ''
					THEN 1 ELSE 0 END) AS siang_complete,
					MAX(CASE WHEN shift_type = 'sore'
						AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
						AND check_in_photo_name IS NOT NULL AND check_in_photo_name <> ''
						AND check_out_photo_name IS NOT NULL AND check_out_photo_name <> ''
					THEN 1 ELSE 0 END) AS sore_complete,
					MAX(CASE WHEN shift_type = 'lembur'
						AND check_in_time IS NOT NULL AND check_out_time IS NOT NULL
						AND check_in_photo_name IS NOT NULL AND check_in_photo_name <> ''
						AND check_out_photo_name IS NOT NULL AND check_out_photo_name <> ''
					THEN 1 ELSE 0 END) AS lembur_complete
				FROM tr_attendance_shift_ikm
				WHERE ${whereSql}
				GROUP BY employee_id, work_date
			`,
			params
		);

		const [employeeSummaryRows] = await safeIKMQuery(
			`
				SELECT
					employee_id,
					COUNT(*) AS total_records,
					SUM(CASE WHEN check_in_time IS NOT NULL THEN 1 ELSE 0 END) AS total_check_in,
					SUM(CASE WHEN check_out_time IS NOT NULL THEN 1 ELSE 0 END) AS total_check_out,
					SUM(
						CASE WHEN shift_type IN ('pagi', 'siang', 'sore')
							AND check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
						THEN GREATEST(TIMESTAMPDIFF(MINUTE, check_in_time, check_out_time), 0)
						ELSE 0 END
					) AS total_absen_minutes,
					SUM(
						CASE WHEN shift_type = 'lembur'
							AND check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
						THEN GREATEST(TIMESTAMPDIFF(MINUTE, check_in_time, check_out_time), 0)
						ELSE 0 END
					) AS total_lembur_minutes,
					SUM(
						CASE WHEN check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						THEN 1 ELSE 0 END
					) AS total_complete,
					MAX(work_date) AS last_work_date
				FROM tr_attendance_shift_ikm
				WHERE ${whereSql}
				GROUP BY employee_id
				ORDER BY total_absen_minutes DESC
				LIMIT 500
			`,
			params
		);

		const { whereSql: todayWhereSql, params: todayParams } = buildTodayWhereSql({
			employeeId,
			employeeIds,
			shiftType,
			search,
			matchedEmployeeIds,
		});

		const [todayRows] = await safeIKMQuery(
			`
				SELECT
					COUNT(*) AS total_today_records,
					COUNT(DISTINCT CASE WHEN check_in_time IS NOT NULL THEN employee_id END) AS present_employees
				FROM tr_attendance_shift_ikm
				WHERE ${todayWhereSql}
			`,
			todayParams
		);

		const [masterEmployeeRows] = await safeQuery(
			`SELECT COUNT(*) AS total FROM mst_employee WHERE is_deleted = 0`,
			[]
		);

		const allEmployeeIds = [...new Set([
			...rows.map((row) => Number(row.employee_id)),
			...employeeSummaryRows.map((row) => Number(row.employee_id)),
		])].filter((id) => Number.isInteger(id) && id > 0);

		const [employeeMap, leaderRoleMap] = await Promise.all([
			getEmployeeProfileMap(allEmployeeIds),
			getLeaderRoleMap(allEmployeeIds),
		]);

		let completedMandatorySlots = 0;
		let availableMandatorySlots = 0;
		let lemburExists = 0;
		let lemburComplete = 0;

		for (const row of dailyRows) {
			availableMandatorySlots += 3;
			completedMandatorySlots += Number(row.pagi_complete || 0);
			completedMandatorySlots += Number(row.siang_complete || 0);
			completedMandatorySlots += Number(row.sore_complete || 0);
			if (Number(row.has_lembur || 0) === 1) {
				lemburExists += 1;
				lemburComplete += Number(row.lembur_complete || 0);
			}
		}

		const mandatoryCompletionRate =
			availableMandatorySlots > 0
				? Number(((completedMandatorySlots / availableMandatorySlots) * 100).toFixed(2))
				: 0;

		const records = rows.map((row) => {
			const hasCheckIn = Boolean(row.check_in_time);
			const hasCheckOut = Boolean(row.check_out_time);
			const hasCheckInPhoto = Boolean(row.check_in_photo_name);
			const hasCheckOutPhoto = Boolean(row.check_out_photo_name);
			const profile = getEmployeeView(employeeMap, row.employee_id);

			return {
				...row,
				employee_name: profile.employee_name,
				employee_code: profile.employee_code,
				jabatan: profile.jabatan,
				check_in_photo_url: buildPhotoUrl(row.check_in_photo_path, row.check_in_photo_name),
				check_out_photo_url: buildPhotoUrl(row.check_out_photo_path, row.check_out_photo_name),
				is_check_in_complete: hasCheckIn && hasCheckInPhoto,
				is_check_out_complete: hasCheckOut && hasCheckOutPhoto,
				is_full_complete: hasCheckIn && hasCheckOut && hasCheckInPhoto && hasCheckOutPhoto,
				status_label: getRecordStatus(row),
			};
		});

		const summary = summaryRows[0] || {};
		const todaySummary = todayRows[0] || {};
		const totalMasterEmployees = Number(masterEmployeeRows[0]?.total || 0);
		const presentEmployeesToday = Number(todaySummary.present_employees || 0);
		const dummyAbsentEmployees = Math.max(totalMasterEmployees - presentEmployeesToday, 0);

		const employeeSummary = employeeSummaryRows
			.map((row) => {
				const profile = getEmployeeView(employeeMap, row.employee_id);
				const leaderRole = leaderRoleMap.get(Number(row.employee_id));
				return {
					employee_id: Number(row.employee_id),
					employee_name: profile.employee_name,
					employee_code: profile.employee_code,
					jabatan: leaderRole || "staff",
					total_records: Number(row.total_records || 0),
					total_check_in: Number(row.total_check_in || 0),
					total_check_out: Number(row.total_check_out || 0),
					total_absen_minutes: Number(row.total_absen_minutes || 0),
					total_lembur_minutes: Number(row.total_lembur_minutes || 0),
					total_complete: Number(row.total_complete || 0),
					last_work_date: row.last_work_date,
				};
			});

		const employeeOptions = await getEmployeeSelectionOptions();

		// Leave counts for the active period from tr_employee_leaves
		const [leaveCountRows] = await safeIKMQuery(
			`
				SELECT leave_type, COUNT(*) AS cnt
				FROM tr_employee_leaves
				WHERE start_date <= ? AND end_date >= ?
				GROUP BY leave_type
			`,
			[endDate, startDate]
		);
		const leaveSummary = { izin: 0, sakit: 0, cuti: 0 };
		for (const r of leaveCountRows) {
			if (r.leave_type in leaveSummary) leaveSummary[r.leave_type] = Number(r.cnt);
		}

		return res.json({
			success: true,
			filters: {
				startDate,
				endDate,
				employeeId: employeeId || null,
				employeeIds,
				search: search || null,
				shiftType: shiftType || null,
				onlyIncomplete,
			},
			pagination: {
				total,
				page,
				limit,
				totalPages: total > 0 ? Math.ceil(total / limit) : 1,
			},
			summary: {
				totalRecords: Number(summary.total_records || 0),
				totalEmployees: Number(summary.total_employees || 0),
				totalCheckIn: Number(summary.total_check_in || 0),
				totalCheckOut: Number(summary.total_check_out || 0),
				totalTimeComplete: Number(summary.total_time_complete || 0),
				totalPhotoComplete: Number(summary.total_photo_complete || 0),
				totalFullComplete: Number(summary.total_full_complete || 0),
				pendingCheckIn: Number(summary.pending_checkin || 0),
				pendingCheckOut: Number(summary.pending_checkout || 0),
				dailyEmployeeCount: dailyRows.length,
				availableMandatorySlots,
				completedMandatorySlots,
				missingMandatorySlots: Math.max(availableMandatorySlots - completedMandatorySlots, 0),
				mandatoryCompletionRate,
				lemburExists,
				lemburComplete,
				todayRecords: Number(todaySummary.total_today_records || 0),
				todayPresentEmployees: presentEmployeesToday,
				dummyAbsentEmployees,
				totalMasterEmployees,
				leaveSummary,
			},
			employeeOptions,
			employeeSummary,
			records,
		});
	} catch (error) {
		console.error("[getAttendanceShiftIKM] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal mengambil data absensi IKM",
		});
	}
};
