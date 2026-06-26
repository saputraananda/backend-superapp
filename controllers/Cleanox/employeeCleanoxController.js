import { pool, safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import bcrypt from "bcrypt";

const SORT_COLUMNS = {
  full_name: "e.full_name",
  employee_code: "e.employee_code",
  username: "u.username",
  join_date: "e.join_date",
  company_name: "c.company_name",
};

export const listCleanoxEmployees = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const sortByKey = String(req.query.sortBy || "full_name");
    const sortBy = SORT_COLUMNS[sortByKey] || SORT_COLUMNS.full_name;
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    // Fetch mst_role entries (produksi/frontliner from company 3 & 5)
    const [roleRows] = await safeCleanoxQuery("SELECT employee_id, role FROM mst_role");
    const roleMap = {};
    for (const rr of roleRows) roleMap[rr.employee_id] = rr.role;
    const assignedIds = Object.keys(roleMap).map(Number);

    if (assignedIds.length === 0) {
      return res.json({ success: true, total: 0, data: [] });
    }

    const conditions = ["e.is_deleted = 0"];
    const params = [];

    // Only company 3/5 that have mst_role
    const ph = assignedIds.map(() => "?").join(", ");
    conditions.push(`e.company_id IN (3, 5)`);
    conditions.push(`e.employee_id IN (${ph})`);
    params.push(...assignedIds);

    if (search) {
      conditions.push("(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR u.username LIKE ?)");
      const kw = `%${search}%`;
      params.push(kw, kw, kw, kw);
    }

    const whereSql = `WHERE ${conditions.join(" AND ")}`;

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
      `,
      params,
    );

    const data = rows.map((r) => ({
      ...r,
      cleanox_role: roleMap[r.employee_id] ?? null,
    }));

    return res.json({ success: true, total: data.length, data });
  } catch (error) {
    console.error("[listCleanoxEmployees] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data karyawan Cleanox",
    });
  }
};

export const getAssignableEmployees = async (req, res) => {
  try {
    // Employees from company 3 & 5 not yet in mst_role (active)
    const [roleRows] = await safeCleanoxQuery("SELECT employee_id FROM mst_role");
    const assignedIds = roleRows.map((rr) => rr.employee_id);

    let query =
      "SELECT employee_id, full_name, employee_code, email, company_id FROM mst_employee WHERE company_id IN (3, 5) AND exit_date IS NULL AND is_deleted = 0";
    const params = [];

    if (assignedIds.length > 0) {
      const ph = assignedIds.map(() => "?").join(", ");
      query += ` AND employee_id NOT IN (${ph})`;
      params.push(...assignedIds);
    }

    query += " ORDER BY full_name ASC";

    const [rows] = await safeQuery(query, params);

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[getAssignableEmployees] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data karyawan yang tersedia",
    });
  }
};

export const addCleanoxEmployee = async (req, res) => {
  try {
    const { mode, employee_id, role, full_name, email, username, password, company_id } = req.body;

    const ALLOWED_ROLES = ["produksi", "frontliner"];

    if (mode === "existing") {
      if (!employee_id) {
        return res.status(400).json({ message: "ID Karyawan wajib diisi." });
      }

      // Only company 3 & 5 can be assigned
      const [emp] = await safeQuery(
        "SELECT employee_id FROM mst_employee WHERE employee_id = ? AND company_id IN (3, 5) AND exit_date IS NULL AND is_deleted = 0 LIMIT 1",
        [employee_id],
      );
      if (emp.length === 0) {
        return res.status(400).json({ message: "Karyawan tidak ditemukan atau tidak aktif di perusahaan 3 atau 5" });
      }

      const [exist] = await safeCleanoxQuery("SELECT employee_id FROM mst_role WHERE employee_id = ? LIMIT 1", [employee_id]);
      if (exist.length > 0) {
        return res.status(400).json({ message: "Karyawan sudah ditugaskan di Cleanox" });
      }

      const assignRole = role && ALLOWED_ROLES.includes(role) ? role : "produksi";
      await safeCleanoxQuery("INSERT INTO mst_role (employee_id, role) VALUES (?, ?)", [employee_id, assignRole]);

      return res.json({ success: true, message: "Karyawan berhasil ditambahkan ke Cleanox" });
    } else if (mode === "new") {
      if (!full_name || !email || !username || !password || !company_id) {
        return res.status(400).json({ message: "Seluruh bidang wajib diisi untuk karyawan baru." });
      }

      const cleanCompanyId = Number(company_id);
      if (![3, 5].includes(cleanCompanyId)) {
        return res.status(400).json({ message: "Perusahaan harus 3 (Cleanox) atau 5 (Waschen)." });
      }

      const [existEmail] = await safeQuery("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existEmail.length > 0) return res.status(400).json({ message: "Email sudah terdaftar." });

      const [existUser] = await safeQuery("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
      if (existUser.length > 0) return res.status(400).json({ message: "Username sudah terdaftar." });

      const password_hash = await bcrypt.hash(password, 10);

      await safeQuery("INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'employee')", [
        full_name, email, username, password_hash,
      ]);

      const [empResult] = await safeQuery(
        "INSERT INTO mst_employee (full_name, email, company_id) VALUES (?, ?, ?)",
        [full_name, email, cleanCompanyId],
      );
      const newEmployeeId = empResult.insertId;

      const assignRole = role && ALLOWED_ROLES.includes(role) ? role : "produksi";
      await safeCleanoxQuery("INSERT INTO mst_role (employee_id, role) VALUES (?, ?)", [newEmployeeId, assignRole]);

      return res.json({ success: true, message: "Karyawan baru berhasil ditambahkan" });
    } else {
      return res.status(400).json({ message: "Mode tidak valid." });
    }
  } catch (error) {
    console.error("[addCleanoxEmployee] Error:", error);
    return res.status(500).json({ message: error.message || "Gagal menambahkan karyawan Cleanox" });
  }
};

export const updateEmployeeRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    const ALLOWED_ROLES = ["produksi", "frontliner"];
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ message: "Role tidak valid." });
    }

    const [emp] = await safeQuery(
      "SELECT employee_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1",
      [id]
    );
    if (emp.length === 0) {
      return res.status(404).json({ message: "Karyawan tidak ditemukan." });
    }

    const [exist] = await safeCleanoxQuery("SELECT employee_id FROM mst_role WHERE employee_id = ? LIMIT 1", [id]);
    if (exist.length > 0) {
      await safeCleanoxQuery("UPDATE mst_role SET role = ? WHERE employee_id = ?", [role, id]);
    } else {
      await safeCleanoxQuery("INSERT INTO mst_role (employee_id, role) VALUES (?, ?)", [id, role]);
    }

    return res.json({ success: true, message: "Unit/bagian karyawan berhasil diperbarui." });
  } catch (error) {
    console.error("[updateEmployeeRole] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal memperbarui unit/bagian karyawan",
    });
  }
};
