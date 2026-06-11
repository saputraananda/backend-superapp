import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const IKM_COMPANY_ID = 2;
const ADMIN_EMPLOYEE_ID = 31;

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

async function getManagementEmployeeIds() {
	const [rows] = await safeIKMQuery(
		`SELECT employee_id FROM mst_leader WHERE role = 'management'`,
		[]
	);
	return rows.map((r) => Number(r.employee_id)).filter((id) => id > 0);
}

async function getEmployeeSelectionOptions() {
	const managementIds = await getManagementEmployeeIds();
	if (managementIds.length === 0) return [];

	const placeholders = managementIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name
			FROM mst_employee e
			WHERE e.is_deleted = 0
				AND e.employee_id IN (${placeholders})
			ORDER BY e.full_name ASC
			LIMIT 3000
		`,
		[...managementIds]
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
		const parts = [row.job_level_name, row.position_name].filter(Boolean);
		map.set(Number(row.employee_id), {
			employee_code: row.employee_code || null,
			employee_name: row.full_name || null,
			jabatan: parts.length > 0 ? parts.join(" ") : "-",
		});
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

function toMySQLDatetime(value) {
	if (!value) return null;
	const normalized = String(value).replace("T", " ").slice(0, 19);
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;
	return normalized.length === 16 ? `${normalized}:00` : normalized;
}

/**
 * GET /ikm/absensi-manajemen/management
 * Fetches management attendance data (no shift concept).
 */
export const getManagementAttendance = async (req, res) => {
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
		const statusFilter = String(req.query.status || "").trim();

		const matchedEmployeeIds = await getMatchedEmployeeIdsBySearch(search);

		// Build WHERE clause
		const where = ["work_date BETWEEN ? AND ?"];
		const params = [startDate, endDate];

		if (employeeIds.length > 0) {
			where.push(`employee_id IN (${employeeIds.map(() => "?").join(",")})`);
			params.push(...employeeIds);
		} else if (employeeId) {
			where.push("employee_id = ?");
			params.push(employeeId);
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

		const whereSql = where.join(" AND ");

		// Count
		const [countRows] = await safeIKMQuery(
			`SELECT COUNT(*) AS total FROM tr_attendance_management_ikm WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows[0]?.total || 0);

		// Records
		const [rows] = await safeIKMQuery(
			`
				SELECT
					mgmt_record_id,
					user_id,
					employee_id,
					work_date,
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
				FROM tr_attendance_management_ikm
				WHERE ${whereSql}
				ORDER BY check_in_time DESC, mgmt_record_id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		// Summary
		const [summaryRows] = await safeIKMQuery(
			`
				SELECT
					COUNT(*) AS total_records,
					COUNT(DISTINCT employee_id) AS total_employees,
					SUM(CASE WHEN check_in_time IS NOT NULL THEN 1 ELSE 0 END) AS checked_in_count,
					SUM(CASE WHEN check_out_time IS NOT NULL THEN 1 ELSE 0 END) AS checked_out_count,
					SUM(
						CASE WHEN check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						THEN 1 ELSE 0 END
					) AS complete_count,
					SUM(
						CASE WHEN NOT (
							check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						) THEN 1 ELSE 0 END
					) AS incomplete_count
				FROM tr_attendance_management_ikm
				WHERE ${whereSql}
			`,
			params
		);

		// Employee summary
		const [employeeSummaryRows] = await safeIKMQuery(
			`
				SELECT
					employee_id,
					COUNT(*) AS record_count,
					SUM(
						CASE WHEN check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						THEN 1 ELSE 0 END
					) AS complete_count,
					SUM(
						CASE WHEN NOT (
							check_in_time IS NOT NULL
							AND check_out_time IS NOT NULL
							AND check_in_photo_name IS NOT NULL
							AND check_in_photo_name <> ''
							AND check_out_photo_name IS NOT NULL
							AND check_out_photo_name <> ''
						) THEN 1 ELSE 0 END
					) AS incomplete_count
				FROM tr_attendance_management_ikm
				WHERE ${whereSql}
				GROUP BY employee_id
				ORDER BY record_count DESC
				LIMIT 500
			`,
			params
		);

		// Gather all employee IDs
		const allEmployeeIds = [
			...new Set([
				...rows.map((r) => Number(r.employee_id)),
				...employeeSummaryRows.map((r) => Number(r.employee_id)),
			]),
		].filter((id) => Number.isInteger(id) && id > 0);

		const employeeMap = await getEmployeeProfileMap(allEmployeeIds);

		// Build records with profile + photo URLs + status
		const records = rows.map((row) => {
			const profile = getEmployeeView(employeeMap, row.employee_id);
			return {
				...row,
				employee_name: profile.employee_name,
				employee_code: profile.employee_code,
				jabatan: profile.jabatan,
				check_in_photo_url: buildPhotoUrl(row.check_in_photo_path, row.check_in_photo_name),
				check_out_photo_url: buildPhotoUrl(row.check_out_photo_path, row.check_out_photo_name),
				status_label: getRecordStatus(row),
			};
		});

		// Filter by status on server side if requested
		let filteredRecords = records;
		if (statusFilter) {
			filteredRecords = records.filter((r) => r.status_label === statusFilter);
		}

		// Build employee summary with profile
		const employeeSummary = employeeSummaryRows.map((row) => {
			const profile = getEmployeeView(employeeMap, row.employee_id);
			return {
				employee_id: Number(row.employee_id),
				employee_name: profile.employee_name,
				employee_code: profile.employee_code,
				jabatan: profile.jabatan,
				record_count: Number(row.record_count || 0),
				complete_count: Number(row.complete_count || 0),
				incomplete_count: Number(row.incomplete_count || 0),
			};
		});

		const employeeOptions = await getEmployeeSelectionOptions();

		const summary = summaryRows[0] || {};

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
				checkedInCount: Number(summary.checked_in_count || 0),
				checkedOutCount: Number(summary.checked_out_count || 0),
				completeCount: Number(summary.complete_count || 0),
				incompleteCount: Number(summary.incomplete_count || 0),
			},
			employeeOptions,
			employeeSummary,
			records: filteredRecords,
		});
	} catch (error) {
		console.error("[getManagementAttendance] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal mengambil data absensi manajemen",
		});
	}
};

/**
 * PUT /ikm/absensi-manajemen/management/:id
 * Admin: edit check_in_time and/or check_out_time of an existing management record.
 */
export const updateManagementAttendance = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ success: false, message: "mgmt_record_id tidak valid" });

		const hasCheckIn = "check_in_time" in req.body;
		const hasCheckOut = "check_out_time" in req.body;

		if (!hasCheckIn && !hasCheckOut) {
			return res.status(400).json({ success: false, message: "Tidak ada field yang diubah. Sediakan check_in_time dan/atau check_out_time." });
		}

		const checkInRaw = hasCheckIn ? req.body.check_in_time : undefined;
		const checkOutRaw = hasCheckOut ? req.body.check_out_time : undefined;

		if (hasCheckIn && checkInRaw !== "" && checkInRaw !== null && !toMySQLDatetime(checkInRaw)) {
			return res.status(400).json({ success: false, message: "Format check_in_time tidak valid. Gunakan YYYY-MM-DDTHH:MM" });
		}
		if (hasCheckOut && checkOutRaw !== "" && checkOutRaw !== null && !toMySQLDatetime(checkOutRaw)) {
			return res.status(400).json({ success: false, message: "Format check_out_time tidak valid. Gunakan YYYY-MM-DDTHH:MM" });
		}

		const [existing] = await safeIKMQuery(
			"SELECT mgmt_record_id, check_in_time, check_out_time FROM tr_attendance_management_ikm WHERE mgmt_record_id = ?",
			[id]
		);
		if (!existing.length) return res.status(404).json({ success: false, message: "Record absensi manajemen tidak ditemukan" });

		const record = existing[0];
		const finalCheckIn = hasCheckIn
			? (checkInRaw === "" || checkInRaw === null ? null : toMySQLDatetime(checkInRaw))
			: record.check_in_time;
		const finalCheckOut = hasCheckOut
			? (checkOutRaw === "" || checkOutRaw === null ? null : toMySQLDatetime(checkOutRaw))
			: record.check_out_time;

		if (finalCheckIn && finalCheckOut && new Date(finalCheckOut) <= new Date(finalCheckIn)) {
			return res.status(400).json({ success: false, message: "Jam keluar harus lebih besar dari jam masuk" });
		}

		const setClauses = [];
		const updateParams = [];

		if (hasCheckIn) {
			setClauses.push("check_in_time = ?");
			updateParams.push(finalCheckIn);
		}
		if (hasCheckOut) {
			setClauses.push("check_out_time = ?");
			updateParams.push(finalCheckOut);
		}
		updateParams.push(id);

		await safeIKMQuery(
			`UPDATE tr_attendance_management_ikm SET ${setClauses.join(", ")} WHERE mgmt_record_id = ?`,
			updateParams
		);

		return res.json({ success: true, message: "Data absensi manajemen berhasil diperbarui" });
	} catch (error) {
		console.error("[updateManagementAttendance] Error:", error);
		return res.status(500).json({ success: false, message: error.message || "Gagal memperbarui data absensi manajemen" });
	}
};

/**
 * DELETE /ikm/absensi-manajemen/management/:id
 * Admin: delete a management attendance record by mgmt_record_id.
 */
export const deleteManagementAttendance = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ success: false, message: "mgmt_record_id tidak valid" });

		const [existing] = await safeIKMQuery(
			"SELECT mgmt_record_id FROM tr_attendance_management_ikm WHERE mgmt_record_id = ?",
			[id]
		);
		if (!existing.length) return res.status(404).json({ success: false, message: "Record absensi manajemen tidak ditemukan" });

		await safeIKMQuery("DELETE FROM tr_attendance_management_ikm WHERE mgmt_record_id = ?", [id]);

		return res.json({ success: true, message: "Record absensi manajemen berhasil dihapus" });
	} catch (error) {
		console.error("[deleteManagementAttendance] Error:", error);
		return res.status(500).json({ success: false, message: error.message || "Gagal menghapus record absensi manajemen" });
	}
};

/**
 * POST /ikm/absensi-manajemen/management
 * Admin: tambah record absensi manajemen secara manual.
 */
export const createManagementAttendance = async (req, res) => {
	try {
		const employeeId = toPositiveInt(req.body.employee_id);
		if (!employeeId) {
			return res.status(400).json({ success: false, message: "employee_id tidak valid" });
		}

		// Verify employee exists (IKM company or special employee)
		const [empRows] = await safeQuery(
			"SELECT employee_id FROM mst_employee WHERE employee_id = ? AND (company_id = ? OR employee_id = ?) AND is_deleted = 0 LIMIT 1",
			[employeeId, IKM_COMPANY_ID, ADMIN_EMPLOYEE_ID]
		);
		if (empRows.length === 0) {
			return res.status(404).json({ success: false, message: "Karyawan tidak ditemukan" });
		}

		const workDate = toISODateString(req.body.work_date);
		if (!workDate) {
			return res.status(400).json({ success: false, message: "work_date tidak valid (format: YYYY-MM-DD)" });
		}

		const checkInRaw = req.body.check_in_time || null;
		const checkOutRaw = req.body.check_out_time || null;
		const checkInTime = checkInRaw ? toMySQLDatetime(checkInRaw) : null;
		const checkOutTime = checkOutRaw ? toMySQLDatetime(checkOutRaw) : null;

		if (checkInRaw && !checkInTime) {
			return res.status(400).json({ success: false, message: "Format check_in_time tidak valid. Gunakan YYYY-MM-DDTHH:MM" });
		}
		if (checkOutRaw && !checkOutTime) {
			return res.status(400).json({ success: false, message: "Format check_out_time tidak valid. Gunakan YYYY-MM-DDTHH:MM" });
		}
		if (checkInTime && checkOutTime && new Date(checkOutTime) <= new Date(checkInTime)) {
			return res.status(400).json({ success: false, message: "Jam keluar harus lebih besar dari jam masuk" });
		}

		// Check for duplicate (employee_id + work_date)
		const [existing] = await safeIKMQuery(
			"SELECT mgmt_record_id FROM tr_attendance_management_ikm WHERE employee_id = ? AND work_date = ?",
			[employeeId, workDate]
		);
		if (existing.length > 0) {
			return res.status(409).json({
				success: false,
				message: "Record absensi manajemen untuk karyawan dan tanggal ini sudah ada",
			});
		}

		await safeIKMQuery(
			`INSERT INTO tr_attendance_management_ikm (user_id, employee_id, work_date, check_in_time, check_out_time)
			 VALUES (?, ?, ?, ?, ?)`,
			[ADMIN_EMPLOYEE_ID, employeeId, workDate, checkInTime, checkOutTime]
		);

		return res.status(201).json({ success: true, message: "Data absensi manajemen berhasil ditambahkan" });
	} catch (error) {
		console.error("[createManagementAttendance] Error:", error);
		return res.status(500).json({ success: false, message: error.message || "Gagal menambahkan data absensi manajemen" });
	}
};
