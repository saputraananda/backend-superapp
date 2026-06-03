import { safeQuery } from "../db/pool.js";

// ── DASHBOARD SUMMARY ──────────────────────────────────────────────────────
export const getDashboardSummary = async (req, res) => {
  try {
    const companyFilter = req.query.company_id ? "AND e.company_id = ?" : "";
    const params = req.query.company_id ? [req.query.company_id] : [];

    const [[{ total }]]             = await safeQuery(`SELECT COUNT(*) as total FROM mst_employee e WHERE e.is_deleted = 0 ${companyFilter}`, params);
    const [[{ active }]]            = await safeQuery(`SELECT COUNT(*) as active FROM mst_employee e WHERE e.is_deleted = 0 AND e.employment_status_id IS NOT NULL ${companyFilter}`, params);
    const [[{ resigned }]]          = await safeQuery(`SELECT COUNT(*) as resigned FROM mst_employee e WHERE e.is_deleted = 0 AND e.exit_date IS NOT NULL ${companyFilter}`, params);
    const [[{ contract_ending }]]   = await safeQuery(
      `SELECT COUNT(*) as contract_ending FROM mst_employee e
       WHERE e.is_deleted = 0 AND e.contract_end_date IS NOT NULL
       AND e.contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       ${companyFilter}`, params
    );
    const [[{ incomplete_profile }]] = await safeQuery(
      `SELECT COUNT(*) as incomplete_profile FROM mst_employee e
       WHERE e.is_deleted = 0
       AND (e.phone_number IS NULL OR e.address IS NULL OR e.ktp_number IS NULL OR e.bank_account_number IS NULL)
       ${companyFilter}`, params
    );

    const [byDepartment] = await safeQuery(
      `SELECT d.department_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY d.department_name ORDER BY total DESC`, params
    );

    const [byStatus] = await safeQuery(
      `SELECT es.employment_status_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY es.employment_status_name ORDER BY total DESC`, params
    );

    const [byCompany] = await safeQuery(
      `SELECT c.company_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_company c ON e.company_id = c.company_id
       WHERE e.is_deleted = 0
       GROUP BY c.company_name ORDER BY total DESC`
    );

    const [recentJoins] = await safeQuery(
      `SELECT e.full_name, e.join_date, c.company_name, p.position_name, d.department_name
       FROM mst_employee e
       LEFT JOIN mst_company    c ON e.company_id    = c.company_id
       LEFT JOIN mst_position   p ON e.position_id   = p.position_id
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0
       AND MONTH(e.join_date) = MONTH(CURDATE()) AND YEAR(e.join_date) = YEAR(CURDATE())
       ${companyFilter}
       ORDER BY e.join_date DESC LIMIT 5`, params
    );

    res.json({ total, active, resigned, contract_ending, incomplete_profile, byDepartment, byStatus, byCompany, recentJoins });
  } catch (err) {
    console.error("getDashboardSummary error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── LIST EMPLOYEES ─────────────────────────────────────────────────────────
export const listEmployees = async (req, res) => {
  try {
    const { company_id, department_id, status, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ["e.is_deleted = 0"];
    const params     = [];

    if (company_id)    { conditions.push("e.company_id = ?");    params.push(company_id); }
    if (department_id) { conditions.push("e.department_id = ?"); params.push(department_id); }
    if (status === "active")   conditions.push("e.exit_date IS NULL");
    if (status === "resigned") conditions.push("e.exit_date IS NOT NULL");
    if (status === "contract_ending") {
      conditions.push("e.contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)");
    }
    if (search) {
      conditions.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.ktp_number LIKE ? OR u.username LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = "WHERE " + conditions.join(" AND ");

    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) as total FROM mst_employee e
       LEFT JOIN users u ON u.email = e.email
       ${where}`, params
    );

    const [rows] = await safeQuery(
      `SELECT
        e.employee_id, e.full_name, e.email, e.phone_number,
        e.join_date, e.contract_end_date, e.exit_date,
        e.profile_path, e.gender, e.birth_place, e.birth_date, e.address,
        e.ktp_number, e.family_card_number, e.religion_id,
        e.marital_status, e.company_id, e.department_id,
        e.position_id, e.employment_status_id,
        e.education_level_id, e.school_name, e.bank_id,
        e.bank_account_number, e.bpjs_health_number,
        e.bpjs_employment_number, e.npwp_number,
        e.emergency_contact, e.notes, e.ktp_path,
        e.employee_code,
        u.username,
        c.company_name, d.department_name, p.position_name,
        es.employment_status_name, j.job_level_name
       FROM mst_employee e
       LEFT JOIN users                 u  ON u.email              = e.email
       LEFT JOIN mst_company           c  ON e.company_id          = c.company_id
       LEFT JOIN mst_department        d  ON e.department_id       = d.department_id
       LEFT JOIN mst_position          p  ON e.position_id         = p.position_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       LEFT JOIN mst_job_level         j  ON e.job_level_id        = j.job_level_id
       ${where}
       ORDER BY e.full_name ASC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    res.json({ total, page: parseInt(page), limit: parseInt(limit), data: rows });
  } catch (err) {
    console.error("listEmployees error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET SINGLE EMPLOYEE ────────────────────────────────────────────────────
export const getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeQuery(
      `SELECT e.*,
        u.username,
        c.company_name, d.department_name, p.position_name,
        j.job_level_name, es.employment_status_name,
        ed.education_level_name, r.religion_name, b.bank_name
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
       WHERE e.employee_id = ? AND e.is_deleted = 0`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    const emp = rows[0];
    if (parseInt(emp.company_id) === 2) {
      emp.documents_base_url = process.env.IKM_DOCUMENTS_BASE_URL || "https://api.ikmalora.com/storage/documents";
      emp.avatars_base_url   = process.env.IKM_AVATARS_BASE_URL   || "https://api.ikmalora.com/storage/avatars";
    } else {
      emp.documents_base_url = null;
      emp.avatars_base_url   = null;
    }

    res.json({ employee: emp });
  } catch (err) {
    console.error("getEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE EMPLOYEE ────────────────────────────────────────────────────────
export const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      full_name, gender, birth_place, birth_date, address, ktp_number,
      family_card_number, phone_number, company_id, job_level_id, position_id,
      department_id, join_date, employment_status_id, contract_end_date,
      exit_date, exit_reason, education_level_id, school_name, major_name, religion_id,
      marital_status, bpjs_health_number, bpjs_employment_number, npwp_number,
      bank_id, bank_account_number, emergency_contact, notes, employee_code,
      username, mother_name, email, private_email,
    } = req.body;

    if (!employee_code?.trim()) {
      return res.status(400).json({ message: "Nomor Induk Karyawan wajib diisi." });
    }

    const [[existing]] = await safeQuery(
      "SELECT employee_id FROM mst_employee WHERE employee_code = ? AND employee_id != ? AND is_deleted = 0",
      [employee_code, id]
    );
    if (existing) {
      return res.status(400).json({ message: "Nomor Induk Karyawan sudah digunakan oleh karyawan lain." });
    }

    // Validasi email unik jika diisi
    if (email?.trim()) {
      const [[existEmail]] = await safeQuery(
        "SELECT employee_id FROM mst_employee WHERE email = ? AND employee_id != ? AND is_deleted = 0",
        [email.trim(), id]
      );
      if (existEmail) {
        return res.status(400).json({ message: "Email sudah digunakan oleh karyawan lain." });
      }
    }

    // ← Cek username unik jika diisi
    if (username?.trim()) {
      const [[emp]] = await safeQuery(
        "SELECT email FROM mst_employee WHERE employee_id = ? AND is_deleted = 0", [id]
      );
      const [[existUsername]] = await safeQuery(
        "SELECT id FROM users WHERE username = ? AND email != ?",
        [username.trim(), emp?.email ?? ""]
      );
      if (existUsername) {
        return res.status(400).json({ message: "Username sudah digunakan oleh pengguna lain." });
      }
    }

    // Ambil email lama sebelum update (untuk sinkronisasi tabel users)
    const [[empBefore]] = await safeQuery(
      "SELECT email FROM mst_employee WHERE employee_id = ? AND is_deleted = 0", [id]
    );
    const oldEmail = empBefore?.email ?? null;
    const newEmail = email?.trim() || oldEmail;

    await safeQuery(
      `UPDATE mst_employee SET
        full_name = ?, gender = ?, birth_place = ?, birth_date = ?,
        address = ?, ktp_number = ?, family_card_number = ?,
        phone_number = ?, company_id = ?, job_level_id = ?, position_id = ?,
        department_id = ?, join_date = ?, employment_status_id = ?,
        contract_end_date = ?, exit_date = ?, exit_reason = ?,
        education_level_id = ?, school_name = ?, major_name = ?, religion_id = ?,
        marital_status = ?, bpjs_health_number = ?, bpjs_employment_number = ?,
        npwp_number = ?, bank_id = ?, bank_account_number = ?,
        emergency_contact = ?, notes = ?, employee_code = ?, mother_name = ?,
        email = ?, private_email = ?
       WHERE employee_id = ? AND is_deleted = 0`,
      [
        full_name, gender, birth_place, birth_date, address, ktp_number,
        family_card_number, phone_number, company_id, job_level_id, position_id,
        department_id, join_date, employment_status_id, contract_end_date,
        exit_date || null, exit_reason || null,
        education_level_id, school_name, major_name || null, religion_id, marital_status,
        bpjs_health_number, bpjs_employment_number, npwp_number,
        bank_id, bank_account_number, emergency_contact, notes, employee_code,
        mother_name || null, newEmail, private_email || null, id,
      ]
    );

    // Sinkronisasi email & username di tabel users
    if (oldEmail) {
      const updates = [];
      const uParams = [];

      if (newEmail && newEmail !== oldEmail) {
        updates.push("email = ?");
        uParams.push(newEmail);
      }
      if (typeof username === "string") {
        updates.push("username = ?");
        uParams.push(username.trim() || null);
      }

      if (updates.length > 0) {
        uParams.push(oldEmail);
        await safeQuery(
          `UPDATE users SET ${updates.join(", ")} WHERE email = ?`,
          uParams
        );
      }
    } else if (typeof username === "string" && newEmail) {
      // Tidak ada email lama, coba update berdasarkan email baru
      await safeQuery(
        "UPDATE users SET username = ? WHERE email = ?",
        [username.trim() || null, newEmail]
      );
    }

    res.json({ message: "Data karyawan berhasil diperbarui." });
  } catch (err) {
    console.error("updateEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── SOFT DELETE ────────────────────────────────────────────────────────────
export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    await safeQuery(
      "UPDATE mst_employee SET is_deleted = 1 WHERE employee_id = ?", [id]
    );
    res.json({ message: "Karyawan berhasil dihapus." });
  } catch (err) {
    console.error("deleteEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── MARK RESIGNED ──────────────────────────────────────────────────────────
export const resignEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { exit_date, exit_reason } = req.body;
    if (!exit_date) return res.status(400).json({ message: "Tanggal keluar wajib diisi." });

    await safeQuery(
      "UPDATE mst_employee SET exit_date = ?, exit_reason = ? WHERE employee_id = ? AND is_deleted = 0",
      [exit_date, exit_reason || null, id]
    );
    res.json({ message: "Status karyawan berhasil diperbarui." });
  } catch (err) {
    console.error("resignEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};