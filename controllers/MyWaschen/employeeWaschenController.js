import { pool, safeQuery, safeMyWaschenQuery } from "../../db/pool.js";
import bcrypt from "bcrypt";

const SORT_COLUMNS = {
  full_name: "e.full_name",
  employee_code: "e.employee_code",
  username: "u.username",
  join_date: "e.join_date",
  company_name: "c.company_name",
};

export const listWaschenEmployees = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const sortByKey = String(req.query.sortBy || "full_name");
    const sortBy = SORT_COLUMNS[sortByKey] || SORT_COLUMNS.full_name;
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const filterRole = req.query.role ? String(req.query.role) : null;
    const filterOutletId = req.query.outletId ? Number(req.query.outletId) : null;
    const filterIsLeader = req.query.isLeader !== undefined && req.query.isLeader !== "" ? Number(req.query.isLeader) : null;

    // Fetch mst_role entries (produksi/frontliner from company 5)
    const [roleRows] = await safeMyWaschenQuery("SELECT employee_id, role, is_leader, outlet_id FROM mst_role");
    const roleMap = {};
    for (const rr of roleRows) {
      roleMap[rr.employee_id] = {
        role: rr.role,
        is_leader: rr.is_leader,
        outlet_id: rr.outlet_id,
      };
    }

    const conditions = ["e.company_id = 5", "e.is_deleted = 0", "e.exit_date IS NULL"];
    const params = [];

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

    // Fetch outlets to resolve outlet names
    const [outletRows] = await safeQuery("SELECT id, name, full_name FROM mst_outlet");
    const outletMap = {};
    for (const o of outletRows) {
      outletMap[o.id] = o.name;
    }

    let data = rows.map((r) => ({
      ...r,
      waschen_role: roleMap[r.employee_id]?.role ?? null,
      is_leader: roleMap[r.employee_id]?.is_leader ?? null,
      outlet_id: roleMap[r.employee_id]?.outlet_id ?? null,
      outlet_name: roleMap[r.employee_id]?.outlet_id ? (outletMap[roleMap[r.employee_id].outlet_id] ?? "-") : "-",
    }));

    // Apply post-merge filters (role/outlet/leader live in separate DB)
    if (filterRole !== null) {
      data = data.filter((d) => d.waschen_role === filterRole);
    }
    if (filterOutletId !== null) {
      data = data.filter((d) => Number(d.outlet_id) === filterOutletId);
    }
    if (filterIsLeader !== null) {
      data = data.filter((d) => Number(d.is_leader) === filterIsLeader);
    }

    return res.json({ success: true, total: data.length, data });
  } catch (error) {
    console.error("[listWaschenEmployees] Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data karyawan Waschen",
    });
  }
};

export const getAssignableEmployees = async (req, res) => {
  try {
    // Employees from company 5 not yet in mst_role (active)
    const [roleRows] = await safeMyWaschenQuery("SELECT employee_id FROM mst_role");
    const assignedIds = roleRows.map((rr) => rr.employee_id);

    let query =
      "SELECT employee_id, full_name, employee_code, email, company_id FROM mst_employee WHERE company_id = 5 AND exit_date IS NULL AND is_deleted = 0";
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

export const addWaschenEmployee = async (req, res) => {
  try {
    const { mode, employee_id, role, is_leader, outlet_id, full_name, email, username, password } = req.body;

    const ALLOWED_ROLES = ["Frontliner", "Washing Staff", "Ironing Staff", "Packing Staff", "Delivery Staff"];

    if (mode === "existing") {
      if (!employee_id) {
        return res.status(400).json({ message: "ID Karyawan wajib diisi." });
      }

      // Only company 5 can be assigned
      const [emp] = await safeQuery(
        "SELECT employee_id FROM mst_employee WHERE employee_id = ? AND company_id = 5 AND exit_date IS NULL AND is_deleted = 0 LIMIT 1",
        [employee_id],
      );
      if (emp.length === 0) {
        return res.status(400).json({ message: "Karyawan tidak ditemukan atau tidak aktif di perusahaan Waschen Laundry" });
      }

      const [exist] = await safeMyWaschenQuery("SELECT employee_id FROM mst_role WHERE employee_id = ? LIMIT 1", [employee_id]);
      if (exist.length > 0) {
        return res.status(400).json({ message: "Karyawan sudah ditugaskan di Waschen" });
      }

      const assignRole = role && ALLOWED_ROLES.includes(role) ? role : null;
      const cleanIsLeader = is_leader !== undefined && is_leader !== null ? (is_leader ? 1 : 0) : null;
      const cleanOutletId = outlet_id ? Number(outlet_id) : null;
      await safeMyWaschenQuery("INSERT INTO mst_role (employee_id, role, is_leader, outlet_id) VALUES (?, ?, ?, ?)", [employee_id, assignRole, cleanIsLeader, cleanOutletId]);

      return res.json({ success: true, message: "Karyawan berhasil ditambahkan ke Waschen" });
    } else if (mode === "new") {
      if (!full_name || !email || !username || !password) {
        return res.status(400).json({ message: "Seluruh bidang wajib diisi untuk karyawan baru." });
      }

      const cleanCompanyId = 5;

      const [existEmail] = await safeQuery("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existEmail.length > 0) return res.status(400).json({ message: "Email sudah terdaftar." });

      const [existUser] = await safeQuery("SELECT id FROM users WHERE username = ? LIMIT 1", [username]);
      if (existUser.length > 0) return res.status(400).json({ message: "Username sudah terdaftar." });

      const password_hash = await bcrypt.hash(password, 10);

      await safeQuery("INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, 'employee')", [
        full_name, email, username, password_hash,
      ]);

      const [empResult] = await safeQuery(
        "INSERT INTO mst_employee (full_name, email, company_id) VALUES (?, ?, 5)",
        [full_name, email],
      );
      const newEmployeeId = empResult.insertId;

      const assignRole = role && ALLOWED_ROLES.includes(role) ? role : null;
      const cleanIsLeader = is_leader !== undefined && is_leader !== null ? (is_leader ? 1 : 0) : null;
      const cleanOutletId = outlet_id ? Number(outlet_id) : null;
      await safeMyWaschenQuery("INSERT INTO mst_role (employee_id, role, is_leader, outlet_id) VALUES (?, ?, ?, ?)", [newEmployeeId, assignRole, cleanIsLeader, cleanOutletId]);

      return res.json({ success: true, message: "Karyawan baru berhasil ditambahkan" });
    } else {
      return res.status(400).json({ message: "Mode tidak valid." });
    }
  } catch (error) {
    console.error("[addWaschenEmployee] Error:", error);
    return res.status(500).json({ message: error.message || "Gagal menambahkan karyawan Waschen" });
  }
};

export const updateEmployeeRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, is_leader, outlet_id } = req.body;

    const ALLOWED_ROLES = ["Frontliner", "Washing Staff", "Ironing Staff", "Packing Staff", "Delivery Staff"];
    if (role && !ALLOWED_ROLES.includes(role) && role !== "null" && role !== null) {
      return res.status(400).json({ message: "Role tidak valid." });
    }

    const [emp] = await safeQuery(
      "SELECT employee_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1",
      [id]
    );
    if (emp.length === 0) {
      return res.status(404).json({ message: "Karyawan tidak ditemukan." });
    }

    const cleanRole = role && ALLOWED_ROLES.includes(role) ? role : null;
    const cleanIsLeader = is_leader !== undefined && is_leader !== null && is_leader !== "null" && is_leader !== "" ? (Number(is_leader) === 1 ? 1 : 0) : null;
    const cleanOutletId = outlet_id && outlet_id !== "null" && outlet_id !== "" ? Number(outlet_id) : null;

    const [exist] = await safeMyWaschenQuery("SELECT employee_id, role, is_leader, outlet_id FROM mst_role WHERE employee_id = ? LIMIT 1", [id]);
    if (exist.length > 0) {
      const finalRole = role !== undefined ? cleanRole : exist[0].role;
      const finalIsLeader = is_leader !== undefined ? cleanIsLeader : exist[0].is_leader;
      const finalOutletId = outlet_id !== undefined ? cleanOutletId : exist[0].outlet_id;

      if (finalRole === null && finalIsLeader === null && finalOutletId === null) {
        await safeMyWaschenQuery("DELETE FROM mst_role WHERE employee_id = ?", [id]);
      } else {
        const updates = [];
        const params = [];
        if (role !== undefined) {
          updates.push("role = ?");
          params.push(cleanRole);
        }
        if (is_leader !== undefined) {
          updates.push("is_leader = ?");
          params.push(cleanIsLeader);
        }
        if (outlet_id !== undefined) {
          updates.push("outlet_id = ?");
          params.push(cleanOutletId);
        }
        if (updates.length > 0) {
          params.push(id);
          await safeMyWaschenQuery(`UPDATE mst_role SET ${updates.join(", ")} WHERE employee_id = ?`, params);
        }
      }
    } else {
      if (cleanRole !== null || cleanIsLeader !== null || cleanOutletId !== null) {
        await safeMyWaschenQuery("INSERT INTO mst_role (employee_id, role, is_leader, outlet_id) VALUES (?, ?, ?, ?)", [id, cleanRole, cleanIsLeader, cleanOutletId]);
      }
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
