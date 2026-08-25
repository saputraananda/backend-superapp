import fs from "fs";
import path from "path";
import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

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

function toDateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) return toDateInput(value);
	return String(value).slice(0, 10);
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
	const dir = process.env.ALORA_MOBILE_ATTENDANCE_DIR;
	if (!dir) return null;
	return path.resolve(dir);
}

function buildAttendancePhotoUrl(storedPath) {
	if (!storedPath) return null;
	if (/^https?:\/\//i.test(storedPath)) return storedPath;

	const fileName = path.basename(String(storedPath));
	if (!fileName || fileName === "." || fileName === "..") return null;

	const externalBase = (process.env.ALORA_MOBILE_ATTENDANCE_BASE_URL || "").replace(/\/+$/, "");
	if (externalBase) return `${externalBase}/${encodeURIComponent(fileName)}`;

	return `/alora/attendance/photos/${encodeURIComponent(fileName)}`;
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

		const records = (rows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			return {
				attendance_id: Number(row.id),
				employee_id: Number(row.employee_id),
				employee_code: profile.employee_code || null,
				employee_name: profile.employee_name || `ID ${row.employee_id}`,
				jabatan: profile.jabatan || "-",
				work_date: toDateOnly(row.attendance_date),
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
			};
		});

		const employeeSummary = (employeeSummaryRows || []).map((row) => {
			const profile = employeeMap.get(Number(row.employee_id)) || {};
			return {
				employee_id: Number(row.employee_id),
				employee_name: profile.employee_name || `ID ${row.employee_id}`,
				employee_code: profile.employee_code || null,
				jabatan: profile.jabatan || "-",
				record_count: Number(row.record_count || 0),
				complete_count: Number(row.complete_count || 0),
				incomplete_count: Number(row.incomplete_count || 0),
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
				onlyIncomplete,
				status: statusFilter || null,
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
		const dir = getAttendanceDir();
		if (!dir) {
			return res.status(500).json({
				success: false,
				message: "ALORA_MOBILE_ATTENDANCE_DIR belum dikonfigurasi",
			});
		}

		const safeFileName = path.basename(String(req.params.filename || ""));
		if (!safeFileName || safeFileName === "." || safeFileName === "..") {
			return res.status(400).json({ success: false, message: "Nama file tidak valid" });
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
