import bcrypt from "bcrypt";
import { pool, safeQuery, safeIKMQuery } from "../../db/pool.js";

const FIXED_COMPANY_ID = 2;

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

	if (leaderRole === "leader" || leaderRole === "deputi") {
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

		const where = ["e.is_deleted = 0", "e.company_id = ?"];
		const params = [FIXED_COMPANY_ID];

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
			["all", "normal", "leader", "deputi"].includes(leaderRole) ? leaderRole : "all"
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

		// mst_leader ada di IKM DB (server berbeda) → query terpisah lalu merge
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
		const data = rows.map((r) => ({ ...r, leader_role: leaderMap[r.employee_id] ?? null }));

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

export const setIKMEmployeeLeaderRole = async (req, res) => {
	try {
		const id = Number(req.params.id);
		if (!Number.isInteger(id) || id <= 0) {
			return res.status(400).json({ message: "ID tidak valid" });
		}

		// Verify employee exists in company
		const [empRows] = await safeQuery(
			"SELECT employee_id FROM mst_employee WHERE employee_id = ? AND company_id = ? AND is_deleted = 0 LIMIT 1",
			[id, FIXED_COMPANY_ID]
		);
		if (empRows.length === 0) {
			return res.status(404).json({ message: "Karyawan tidak ditemukan" });
		}

		const roleInput = String(req.body?.role || "").trim().toLowerCase();
		const ALLOWED_ROLES = new Set(["leader", "deputi"]);

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
				`INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)` ,
				[fullName, email, username, passwordHash, "employee"]
			);

			const [employeeResult] = await conn.query(
				`INSERT INTO mst_employee (full_name, email, company_id, employee_code) VALUES (?, ?, ?, ?)` ,
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
