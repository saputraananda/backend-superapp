import bcrypt from "bcrypt";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool, safeQuery, safeIKMQuery } from "../../db/pool.js";
import { PAYSLIP_DIR } from "../../middleware/upload.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXED_COMPANY_ID = 2;
const SPECIAL_IKM_EMPLOYEE_ID = 25; // Employee yang diizinkan masuk IKM walau company_id != 2

const SORT_COLUMNS = {
	full_name: "e.full_name",
	jabatan: "COALESCE(j.job_level_name, p.position_name, '')",
	position_name: "p.position_name",
	job_level_name: "j.job_level_name",
	employee_code: "e.employee_code",
	username: "u.username",
	join_date: "e.join_date",
	created_at: "e.created_at",
};

function generateDefaultEmail(name) {
	const token = String(name || "")
		.trim()
		.split(/\s+/)[0]
		?.toLowerCase()
		.replace(/[^a-z0-9]/g, "") || "karyawan";
	return `${token}@ikmalora.com`;
}

function isValidEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

async function resolveLeaderEmployeeIds(leaderRole) {
	if (leaderRole === "all") {
		return null;
	}

	if (leaderRole === "leader" || leaderRole === "deputi" || leaderRole === "management") {
		const [leaderRows] = await safeIKMQuery(
			"SELECT employee_id FROM mst_leader WHERE role = ?",
			[leaderRole]
		);
		return leaderRows.map((row) => row.employee_id);
	}

	const [leaderRows] = await safeIKMQuery("SELECT employee_id FROM mst_leader");
	return {
		excludeIds: leaderRows.map((row) => row.employee_id),
	};
}

async function isAuthorizedForPayslips(employeeId) {
	const loggedInEmpId = Number(employeeId);
	if (!loggedInEmpId) return false;
	const ALLOWED_IDS = [25, 30, 31, 42, 43];
	if (ALLOWED_IDS.includes(loggedInEmpId)) return true;

	const [empRows] = await safeQuery(
		"SELECT job_level_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1",
		[loggedInEmpId]
	);
	if (empRows.length > 0 && Number(empRows[0].job_level_id) === 1) {
		return true;
	}
	return false;
}

export const listIKMEmployees = async (req, res) => {
	try {
		const search = String(req.query.search || "").trim();
		const gender = String(req.query.gender || "").toUpperCase();
		const employment = String(req.query.employment || "all").toLowerCase();
		const hasAccount = String(req.query.hasAccount || "all").toLowerCase();
		const leaderRole = String(req.query.leaderRole || "all").toLowerCase();

		const sortByKey = String(req.query.sortBy || "full_name");
		const sortBy = SORT_COLUMNS[sortByKey] || SORT_COLUMNS.full_name;
		const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

		const page = Math.max(Number(req.query.page) || 1, 1);
		const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
		const offset = (page - 1) * limit;

		const where = ["e.is_deleted = 0", "(e.company_id = ? OR e.employee_id = ?)"];
		const params = [FIXED_COMPANY_ID, SPECIAL_IKM_EMPLOYEE_ID];

		if (search) {
			where.push("(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR u.username LIKE ?)");
			const keyword = `%${search}%`;
			params.push(keyword, keyword, keyword, keyword);
		}

		if (gender === "L" || gender === "P") {
			where.push("e.gender = ?");
			params.push(gender);
		}

		if (employment === "active") {
			where.push("e.exit_date IS NULL");
		} else if (employment === "resigned") {
			where.push("e.exit_date IS NOT NULL");
		}

		if (hasAccount === "yes") {
			where.push("u.id IS NOT NULL");
		} else if (hasAccount === "no") {
			where.push("u.id IS NULL");
		}

		const leaderFilter = await resolveLeaderEmployeeIds(
			["all", "normal", "leader", "deputi", "management"].includes(leaderRole) ? leaderRole : "all"
		);

		if (Array.isArray(leaderFilter)) {
			if (leaderFilter.length === 0) {
				return res.json({
					success: true,
					filters: {
						company_id: FIXED_COMPANY_ID,
						search,
						gender: gender || null,
						employment,
						hasAccount,
						leaderRole,
						sortBy: sortByKey,
						sortDir: sortDir.toLowerCase(),
					},
					pagination: {
						total: 0,
						page,
						limit,
						totalPages: 1,
					},
					data: [],
				});
			}

			where.push(`e.employee_id IN (${leaderFilter.map(() => "?").join(", ")})`);
			params.push(...leaderFilter);
		} else if (leaderFilter?.excludeIds) {
			if (leaderFilter.excludeIds.length > 0) {
				where.push(`e.employee_id NOT IN (${leaderFilter.excludeIds.map(() => "?").join(", ")})`);
				params.push(...leaderFilter.excludeIds);
			}
		}

		const whereSql = `WHERE ${where.join(" AND ")}`;

		const [[{ total }]] = await safeQuery(
			`
				SELECT COUNT(*) AS total
				FROM mst_employee e
				LEFT JOIN users u ON u.email = e.email
				${whereSql}
			`,
			params
		);

		const [rows] = await safeQuery(
			`
				SELECT
					e.employee_id,
					e.employee_code,
					e.full_name,
					e.gender,
					e.phone_number,
					e.email,
					e.join_date,
					e.exit_date,
					e.company_id,
					e.position_id,
					e.job_level_id,
					e.created_at,
					u.id AS user_id,
					u.username,
					c.company_name,
					p.position_name,
					j.job_level_name
				FROM mst_employee e
				LEFT JOIN users u ON u.email = e.email
				LEFT JOIN mst_company c ON c.company_id = e.company_id
				LEFT JOIN mst_position p ON p.position_id = e.position_id
				LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
				${whereSql}
				ORDER BY ${sortBy} ${sortDir}, e.employee_id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		// mst_leader & mst_floor ada di IKM DB (server berbeda) → query terpisah lalu merge
		let leaderMap = {};
		let floorMap = {};
		if (rows.length > 0) {
			const employeeIds = rows.map((r) => r.employee_id);
			const placeholders = employeeIds.map(() => "?").join(", ");
			const [leaderRows] = await safeIKMQuery(
				`SELECT employee_id, role FROM mst_leader WHERE employee_id IN (${placeholders})`,
				employeeIds
			);
			for (const lr of leaderRows) {
				leaderMap[lr.employee_id] = lr.role;
			}
			const [floorRows] = await safeIKMQuery(
				`SELECT employee_id, floor FROM mst_floor WHERE employee_id IN (${placeholders})`,
				employeeIds
			);
			for (const fr of floorRows) {
				floorMap[fr.employee_id] = fr.floor;
			}
		}
		const data = rows.map((r) => ({
			...r,
			leader_role: leaderMap[r.employee_id] ?? null,
			employee_floor: floorMap[r.employee_id] ?? null,
		}));

		return res.json({
			success: true,
			filters: {
				company_id: FIXED_COMPANY_ID,
				search,
				gender: gender || null,
				employment,
				hasAccount,
				leaderRole,
				sortBy: sortByKey,
				sortDir: sortDir.toLowerCase(),
			},
			pagination: {
				total: Number(total || 0),
				page,
				limit,
				totalPages: Number(total || 0) > 0 ? Math.ceil(Number(total || 0) / limit) : 1,
			},
			data: data,
		});
	} catch (error) {
		console.error("[listIKMEmployees] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal mengambil data karyawan IKM",
		});
	}
};

/**
 * Export semua karyawan IKM (company_id = 2) lengkap dengan join master
 * dan path dokumen + base URL untuk avatar / documents.
 * Tidak menggunakan paginasi karena dipakai untuk export Excel.
 */
export const exportIKMEmployees = async (req, res) => {
	try {
		const [rows] = await safeQuery(
			`
				SELECT
					e.employee_id,
					e.employee_code,
					e.full_name,
					e.gender,
					e.birth_place,
					e.birth_date,
					e.address,
					e.ktp_number,
					e.family_card_number,
					e.phone_number,
					e.email,
					e.private_email,
					e.join_date,
					e.contract_end_date,
					e.exit_date,
					e.exit_reason,
					e.school_name,
					e.major_name,
					e.marital_status,
					e.bpjs_health_number,
					e.bpjs_employment_number,
					e.npwp_number,
					e.bank_account_number,
					e.emergency_contact,
					e.notes,
					e.mother_name,
					e.profile_path, e.profile_name,
					e.ktp_path, e.ktp_name,
					e.kk_path, e.kk_name,
					e.npwp_path, e.npwp_name,
					e.bpjs_path, e.bpjs_name,
					e.bpjs_tk_path, e.bpjs_tk_name,
					e.ijazah_path, e.ijazah_name,
					e.sertifikat_path, e.sertifikat_name,
					e.rekomkerja_path, e.rekomkerja_name,
					e.created_at,
					u.username,
					c.company_name,
					d.department_name,
					p.position_name,
					j.job_level_name,
					es.employment_status_name,
					ed.education_level_name,
					r.religion_name,
					b.bank_name
				FROM mst_employee e
				LEFT JOIN users                 u  ON u.email              = e.email
				LEFT JOIN mst_company           c  ON e.company_id          = c.company_id
				LEFT JOIN mst_department        d  ON e.department_id       = d.department_id
				LEFT JOIN mst_position          p  ON e.position_id         = p.position_id
				LEFT JOIN mst_job_level         j  ON e.job_level_id        = j.job_level_id
				LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
				LEFT JOIN mst_education_level   ed ON e.education_level_id  = ed.education_level_id
				LEFT JOIN mst_religion          r  ON e.religion_id         = r.religion_id
				LEFT JOIN mst_bank              b  ON e.bank_id             = b.bank_id
				WHERE e.is_deleted = 0 AND (e.company_id = ? OR e.employee_id = ?)
				ORDER BY e.full_name ASC, e.employee_id ASC
			`,
			[FIXED_COMPANY_ID, SPECIAL_IKM_EMPLOYEE_ID]
		);

		// Merge leader role dari IKM DB
		let leaderMap = {};
		if (rows.length > 0) {
			const employeeIds = rows.map((r) => r.employee_id);
			const placeholders = employeeIds.map(() => "?").join(", ");
			const [leaderRows] = await safeIKMQuery(
				`SELECT employee_id, role FROM mst_leader WHERE employee_id IN (${placeholders})`,
				employeeIds
			);
			for (const lr of leaderRows) {
				leaderMap[lr.employee_id] = lr.role;
			}
		}

		const documentsBaseUrl =
			process.env.IKM_DOCUMENTS_BASE_URL || "https://api.ikmalora.com/storage/documents";
		const avatarsBaseUrl =
			process.env.IKM_AVATARS_BASE_URL || "https://api.ikmalora.com/storage/avatars";

		const data = rows.map((r) => ({
			...r,
			leader_role: leaderMap[r.employee_id] ?? null,
			documents_base_url: documentsBaseUrl,
			avatars_base_url: avatarsBaseUrl,
		}));

		return res.json({
			success: true,
			company_id: FIXED_COMPANY_ID,
			total: data.length,
			documents_base_url: documentsBaseUrl,
			avatars_base_url: avatarsBaseUrl,
			data,
		});
	} catch (error) {
		console.error("[exportIKMEmployees] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal mengambil data export karyawan IKM",
		});
	}
};

/**
 * Proxy untuk dokumen / avatar karyawan IKM agar bisa di-fetch dari frontend
 * tanpa kena CORS (server IKM storage tidak set Access-Control-Allow-Origin).
 *
 * Query:
 *   - kind: "documents" | "avatars" (default "documents")
 *   - name: nama file (mis. "ktp_131_2026-05-18T10-09-20-249Z.jpg")
 *
 * Hanya menerima nama file polos (tanpa "..", tanpa slash) demi keamanan.
 */
export const proxyIKMDocument = async (req, res) => {
	try {
		const kindRaw = String(req.query.kind || "documents").toLowerCase();
		const kind = kindRaw === "avatars" ? "avatars" : "documents";
		const name = String(req.query.name || "").trim();

		if (!name) {
			return res.status(400).json({ message: "Parameter 'name' wajib diisi" });
		}
		// Cegah path traversal & subdirectory
		if (name.includes("..") || name.includes("/") || name.includes("\\")) {
			return res.status(400).json({ message: "Nama file tidak valid" });
		}

		const baseUrl =
			kind === "avatars"
				? process.env.IKM_AVATARS_BASE_URL || "https://api.ikmalora.com/storage/avatars"
				: process.env.IKM_DOCUMENTS_BASE_URL || "https://api.ikmalora.com/storage/documents";

		const targetUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;

		const upstream = await fetch(targetUrl, { method: "GET" });

		if (!upstream.ok) {
			return res
				.status(upstream.status)
				.json({ message: `Gagal memuat file (${upstream.status})` });
		}

		const contentType = upstream.headers.get("content-type") || "application/octet-stream";
		const contentLength = upstream.headers.get("content-length");
		res.setHeader("Content-Type", contentType);
		if (contentLength) res.setHeader("Content-Length", contentLength);
		res.setHeader("Cache-Control", "private, max-age=300");

		// Stream body ke client
		const arrayBuf = await upstream.arrayBuffer();
		res.end(Buffer.from(arrayBuf));
	} catch (error) {
		console.error("[proxyIKMDocument] Error:", error);
		if (!res.headersSent) {
			res.status(500).json({ message: error.message || "Gagal mengambil dokumen" });
		}
	}
};

export const setIKMEmployeeLeaderRole = async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id <= 0) {
			return res.status(400).json({ message: "ID tidak valid" });
		}

		// Verify employee exists in company
		const [empRows] = await safeQuery(
			"SELECT employee_id FROM mst_employee WHERE employee_id = ? AND (company_id = ? OR employee_id = ?) AND is_deleted = 0 LIMIT 1",
			[id, FIXED_COMPANY_ID, SPECIAL_IKM_EMPLOYEE_ID]
		);
		if (empRows.length === 0) {
			return res.status(404).json({ message: "Karyawan tidak ditemukan" });
		}

		const roleInput = String(req.body?.role || "").trim().toLowerCase();
		const ALLOWED_ROLES = new Set(["leader", "deputi", "management"]);

		if (!roleInput || !ALLOWED_ROLES.has(roleInput)) {
			// null / "normal" → remove from mst_leader
			await safeIKMQuery("DELETE FROM mst_leader WHERE employee_id = ?", [id]);
			return res.json({ message: "Role karyawan diubah ke Normal", leader_role: null });
		}

		// leader or deputi → upsert
		await safeIKMQuery(
			`INSERT INTO mst_leader (employee_id, role)
			 VALUES (?, ?)
			 ON DUPLICATE KEY UPDATE role = VALUES(role), updated_at = NOW()`,
			[id, roleInput]
		);

		return res.json({ message: `Karyawan berhasil dijadikan ${roleInput}`, leader_role: roleInput });
	} catch (error) {
		console.error("[setIKMEmployeeLeaderRole] Error:", error);
		return res.status(500).json({ message: error.message || "Gagal mengubah role karyawan" });
	}
};

export const registerIKMEmployee = async (req, res) => {
	const fullName = String(req.body.full_name || req.body.name || "").trim();
	const employeeCodeRaw = String(req.body.employee_code || "").trim();
	const employeeCode = employeeCodeRaw ? employeeCodeRaw.toUpperCase() : null;
	const username = String(req.body.username || "").trim();
	const password = String(req.body.password || "");
	const emailInput = String(req.body.email || "").trim().toLowerCase();
	const email = emailInput || generateDefaultEmail(fullName);

	if (!fullName) {
		return res.status(400).json({ message: "Nama wajib diisi" });
	}
	if (!username) {
		return res.status(400).json({ message: "Username wajib diisi" });
	}
	if (!password) {
		return res.status(400).json({ message: "Password wajib diisi" });
	}
	if (!isValidEmail(email)) {
		return res.status(400).json({ message: "Format email tidak valid" });
	}

	try {
		const [existEmail] = await safeQuery("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
		if (existEmail.length > 0) {
			return res.status(409).json({ message: "Email sudah terdaftar" });
		}

		const [existUsername] = await safeQuery("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
		if (existUsername.length > 0) {
			return res.status(409).json({ message: "Username sudah dipakai" });
		}

		if (employeeCode) {
			const [existEmployeeCode] = await safeQuery(
				"SELECT employee_id FROM mst_employee WHERE employee_code = ? AND company_id = ? AND is_deleted = 0 LIMIT 1",
				[employeeCode, FIXED_COMPANY_ID]
			);
			if (existEmployeeCode.length > 0) {
				return res.status(409).json({ message: "Kode karyawan sudah dipakai" });
			}
		}

		const passwordHash = await bcrypt.hash(password, 10);
		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			const [userResult] = await conn.query(
				`INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
				[fullName, email, username, passwordHash, "employee"]
			);

			const [employeeResult] = await conn.query(
				`INSERT INTO mst_employee (full_name, email, company_id, employee_code) VALUES (?, ?, ?, ?)`,
				[fullName, email, FIXED_COMPANY_ID, employeeCode]
			);

			await conn.commit();

			return res.status(201).json({
				success: true,
				message: "Karyawan berhasil ditambahkan",
				data: {
					user_id: userResult.insertId,
					employee_id: employeeResult.insertId,
					full_name: fullName,
					employee_code: employeeCode,
					email,
					username,
					company_id: FIXED_COMPANY_ID,
				},
			});
		} catch (txErr) {
			await conn.rollback();
			if (txErr?.code === "ER_DUP_ENTRY") {
				return res.status(409).json({
					success: false,
					message: "Data duplikat terdeteksi (email/username/kode karyawan)",
				});
			}
			throw txErr;
		} finally {
			conn.release();
		}
	} catch (error) {
		console.error("[registerIKMEmployee] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal menambahkan karyawan IKM",
		});
	}
};

export const setIKMEmployeeFloor = async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id <= 0) {
			return res.status(400).json({ message: "ID tidak valid" });
		}

		// Verify employee exists in company
		const [empRows] = await safeQuery(
			"SELECT employee_id FROM mst_employee WHERE employee_id = ? AND (company_id = ? OR employee_id = ?) AND is_deleted = 0 LIMIT 1",
			[id, FIXED_COMPANY_ID, SPECIAL_IKM_EMPLOYEE_ID]
		);
		if (empRows.length === 0) {
			return res.status(404).json({ message: "Karyawan tidak ditemukan" });
		}

		const floorInput = String(req.body?.floor || "").trim().toUpperCase();
		const ALLOWED_FLOORS = new Set(["1", "2", "3", "4", "5", "ALL"]);

		if (!floorInput || !ALLOWED_FLOORS.has(floorInput)) {
			// kosong / tidak valid → hapus dari mst_floor
			await safeIKMQuery("DELETE FROM mst_floor WHERE employee_id = ?", [id]);
			return res.json({ message: "Data lantai karyawan dihapus", employee_floor: null });
		}

		// upsert ke mst_floor
		await safeIKMQuery(
			`INSERT INTO mst_floor (employee_id, floor)
			 VALUES (?, ?)
			 ON DUPLICATE KEY UPDATE floor = VALUES(floor), updated_at = NOW()`,
			[id, floorInput]
		);

		return res.json({ message: `Lantai karyawan berhasil diset ke ${floorInput}`, employee_floor: floorInput });
	} catch (error) {
		console.error("[setIKMEmployeeFloor] Error:", error);
		return res.status(500).json({ message: error.message || "Gagal mengubah lantai karyawan" });
	}
};

export const listIKMEmployeePayslips = async (req, res) => {
	try {
		const authorized = await isAuthorizedForPayslips(req.session?.employeeId);
		if (!authorized) {
			return res.status(403).json({ success: false, message: "Anda tidak memiliki akses untuk melihat slip gaji karyawan ini" });
		}

		const employeeId = Number(req.params.id);
		const month = req.query.month; // format: YYYY-MM

		let sql = "SELECT id, employee_id, payslip_month, file_path, file_name, uploaded_by, created_at, updated_at FROM tr_payslip_ikm WHERE employee_id = ?";
		const params = [employeeId];

		if (month) {
			sql += " AND payslip_month = ?";
			params.push(month);
		}

		sql += " ORDER BY payslip_month DESC, id DESC";

		const [rows] = await safeIKMQuery(sql, params);
		return res.json({ success: true, data: rows });
	} catch (error) {
		console.error("[listIKMEmployeePayslips] Error:", error);
		return res.status(500).json({
			success: false,
			message: error.message || "Gagal mengambil data slip gaji",
		});
	}
};

export const uploadIKMEmployeePayslip = async (req, res) => {
	try {
		const authorized = await isAuthorizedForPayslips(req.session?.employeeId);
		if (!authorized) {
			if (req.file) {
				try { fs.unlinkSync(req.file.path); } catch (_) {}
			}
			return res.status(403).json({ success: false, message: "Anda tidak memiliki akses untuk mengupload slip gaji" });
		}

		const employeeId = Number(req.params.id);
		const { payslip_month } = req.body;

		if (!payslip_month || !/^\d{4}-\d{2}$/.test(payslip_month)) {
			if (req.file) {
				try { fs.unlinkSync(req.file.path); } catch (_) {}
			}
			return res.status(400).json({ success: false, message: "Format bulan tidak valid (harus YYYY-MM)" });
		}

		if (!req.file) {
			return res.status(400).json({ success: false, message: "Tidak ada file yang diupload" });
		}

		// Verify employee exists
		const [empRows] = await safeQuery(
			"SELECT employee_id FROM mst_employee WHERE employee_id = ? AND (company_id = ? OR employee_id = ?) AND is_deleted = 0 LIMIT 1",
			[employeeId, FIXED_COMPANY_ID, SPECIAL_IKM_EMPLOYEE_ID]
		);
		if (empRows.length === 0) {
			try { fs.unlinkSync(req.file.path); } catch (_) {}
			return res.status(404).json({ success: false, message: "Karyawan tidak ditemukan" });
		}

		const file_name = req.file.originalname;
		const file_path = req.file.filename;
		const uploaded_by = req.session?.userId || null;

		// Check for existing payslip for same employee + month — delete old file if exists
		const [existing] = await safeIKMQuery(
			"SELECT id, file_path FROM tr_payslip_ikm WHERE employee_id = ? AND payslip_month = ?",
			[employeeId, payslip_month]
		);

		const payslipDir = PAYSLIP_DIR;

		if (existing.length > 0) {
			// Delete the old file from disk
			const oldAbsPath = path.join(payslipDir, path.basename(existing[0].file_path));
			if (fs.existsSync(oldAbsPath)) {
				try { fs.unlinkSync(oldAbsPath); } catch (err) {
					console.error("[uploadIKMEmployeePayslip] Error deleting old file:", err);
				}
			}
			await safeIKMQuery(
				"UPDATE tr_payslip_ikm SET file_name = ?, file_path = ?, uploaded_by = ?, updated_at = NOW() WHERE id = ?",
				[file_name, file_path, uploaded_by, existing[0].id]
			);
		} else {
			await safeIKMQuery(
				"INSERT INTO tr_payslip_ikm (employee_id, payslip_month, file_path, file_name, uploaded_by) VALUES (?, ?, ?, ?, ?)",
				[employeeId, payslip_month, file_path, file_name, uploaded_by]
			);
		}

		return res.json({
			success: true,
			message: "Slip gaji berhasil diupload",
			data: { payslip_month, file_name, file_path },
		});
	} catch (error) {
		console.error("[uploadIKMEmployeePayslip] Error:", error);
		if (req.file) {
			try { fs.unlinkSync(req.file.path); } catch (_) {}
		}
		return res.status(500).json({ success: false, message: error.message || "Gagal mengupload slip gaji" });
	}
};

export const viewIKMEmployeePayslip = async (req, res) => {
	try {
		const authorized = await isAuthorizedForPayslips(req.session?.employeeId);
		if (!authorized) {
			return res.status(403).json({ success: false, message: "Anda tidak memiliki akses untuk melihat slip gaji ini" });
		}

		const employeeId = Number(req.params.id);
		const payslipId = Number(req.params.payslipId);

		const [rows] = await safeIKMQuery(
			"SELECT file_path, file_name FROM tr_payslip_ikm WHERE id = ? AND employee_id = ?",
			[payslipId, employeeId]
		);

		if (rows.length === 0) {
			return res.status(404).json({ success: false, message: "Slip gaji tidak ditemukan" });
		}

		const { file_path, file_name } = rows[0];
		const payslipDir = PAYSLIP_DIR;
		const absPath = path.join(payslipDir, path.basename(file_path));

		if (!fs.existsSync(absPath)) {
			return res.status(404).json({ success: false, message: "File fisik tidak ditemukan di server" });
		}

		const ext = path.extname(absPath).toLowerCase();
		let contentType = "application/octet-stream";
		if (ext === ".pdf") contentType = "application/pdf";
		else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
		else if (ext === ".png") contentType = "image/png";
		else if (ext === ".webp") contentType = "image/webp";

		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Disposition", `inline; filename="${file_name}"`);
		fs.createReadStream(absPath).pipe(res);
	} catch (error) {
		console.error("[viewIKMEmployeePayslip] Error:", error);
		if (!res.headersSent) {
			return res.status(500).json({ success: false, message: error.message || "Gagal memuat slip gaji" });
		}
	}
};

export const deleteIKMEmployeePayslip = async (req, res) => {
	try {
		const authorized = await isAuthorizedForPayslips(req.session?.employeeId);
		if (!authorized) {
			return res.status(403).json({ success: false, message: "Anda tidak memiliki akses untuk menghapus slip gaji ini" });
		}

		const employeeId = Number(req.params.id);
		const payslipId = Number(req.params.payslipId);

		const [rows] = await safeIKMQuery(
			"SELECT file_path FROM tr_payslip_ikm WHERE id = ? AND employee_id = ?",
			[payslipId, employeeId]
		);

		if (rows.length === 0) {
			return res.status(404).json({ success: false, message: "Slip gaji tidak ditemukan" });
		}

		const payslipDir = PAYSLIP_DIR;
		const absPath = path.join(payslipDir, path.basename(rows[0].file_path));

		if (fs.existsSync(absPath)) {
			try { fs.unlinkSync(absPath); } catch (err) {
				console.error("[deleteIKMEmployeePayslip] Error deleting file:", err);
			}
		}

		await safeIKMQuery("DELETE FROM tr_payslip_ikm WHERE id = ?", [payslipId]);

		return res.json({ success: true, message: "Slip gaji berhasil dihapus" });
	} catch (error) {
		console.error("[deleteIKMEmployeePayslip] Error:", error);
		return res.status(500).json({ success: false, message: error.message || "Gagal menghapus slip gaji" });
	}
};
