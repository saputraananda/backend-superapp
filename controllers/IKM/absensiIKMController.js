import { safeIKMQuery } from "../../db/pool.js";

const ALLOWED_SHIFTS = new Set(["pagi", "siang", "sore", "lembur"]);

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toBoolean(value) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "y"].includes(String(value || "").toLowerCase());
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

		const employeeId = Number(req.query.employeeId || 0);
		if (req.query.employeeId && (!Number.isInteger(employeeId) || employeeId <= 0)) {
			return res.status(400).json({ message: "employeeId harus bilangan bulat positif" });
		}

		const page = Math.max(Number(req.query.page) || 1, 1);
		const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
		const offset = (page - 1) * limit;
		const onlyIncomplete = toBoolean(req.query.onlyIncomplete);

		const where = ["work_date BETWEEN ? AND ?"];
		const params = [startDate, endDate];

		if (employeeId) {
			where.push("employee_id = ?");
			params.push(employeeId);
		}

		if (shiftType) {
			where.push("shift_type = ?");
			params.push(shiftType);
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

		const whereSql = where.join(" AND ");

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
					created_at
				FROM tr_attendance_shift_ikm
				WHERE ${whereSql}
				ORDER BY
					work_date DESC,
					employee_id ASC,
					FIELD(shift_type, 'pagi', 'siang', 'sore', 'lembur') ASC,
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

		const dayWhere = ["work_date BETWEEN ? AND ?"];
		const dayParams = [startDate, endDate];
		if (employeeId) {
			dayWhere.push("employee_id = ?");
			dayParams.push(employeeId);
		}

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
				WHERE ${dayWhere.join(" AND ")}
				GROUP BY employee_id, work_date
			`,
			dayParams
		);

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

			return {
				...row,
				check_in_photo_url: buildPhotoUrl(row.check_in_photo_path, row.check_in_photo_name),
				check_out_photo_url: buildPhotoUrl(row.check_out_photo_path, row.check_out_photo_name),
				is_check_in_complete: hasCheckIn && hasCheckInPhoto,
				is_check_out_complete: hasCheckOut && hasCheckOutPhoto,
				is_full_complete: hasCheckIn && hasCheckOut && hasCheckInPhoto && hasCheckOutPhoto,
				status_label: getRecordStatus(row),
			};
		});

		const summary = summaryRows[0] || {};

		return res.json({
			success: true,
			filters: {
				startDate,
				endDate,
				employeeId: employeeId || null,
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
			},
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
