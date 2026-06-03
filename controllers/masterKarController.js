import { safeQuery } from "../db/pool.js";

// ── DASHBOARD SUMMARY ──────────────────────────────────────────────────────
export const getDashboardSummary = async (req, res) => {
  try {
    const companyFilter = req.query.company_id ? "AND e.company_id = ?" : "";
    const companyFilterW = req.query.company_id ? "WHERE e.company_id = ?" : "";
    const params = req.query.company_id ? [req.query.company_id] : [];

    const [[{ total }]]             = await safeQuery(`SELECT COUNT(*) as total FROM mst_employee e WHERE e.is_deleted = 0 ${companyFilter}`, params);
    const [[{ active }]]            = await safeQuery(`SELECT COUNT(*) as active FROM mst_employee e WHERE e.is_deleted = 0 AND e.exit_date IS NULL AND e.employment_status_id IS NOT NULL ${companyFilter}`, params);
    const [[{ resigned }]]          = await safeQuery(`SELECT COUNT(*) as resigned FROM mst_employee e WHERE e.is_deleted = 0 AND e.exit_date IS NOT NULL ${companyFilter}`, params);
    const [[{ contract_ending }]]   = await safeQuery(
      `SELECT COUNT(*) as contract_ending FROM mst_employee e
       WHERE e.is_deleted = 0 AND e.exit_date IS NULL AND e.contract_end_date IS NOT NULL
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
      `SELECT COALESCE(d.department_name, 'Belum Diisi') as department_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY d.department_name ORDER BY total DESC`, params
    );

    const [byStatus] = await safeQuery(
      `SELECT COALESCE(es.employment_status_name, 'Belum Diisi') as employment_status_name, COUNT(*) as total
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

    const [byGender] = await safeQuery(
      `SELECT COALESCE(e.gender, 'Belum Diisi') as gender, COUNT(*) as total
       FROM mst_employee e
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY e.gender ORDER BY total DESC`, params
    );

    const [byEducation] = await safeQuery(
      `SELECT COALESCE(el.education_level_name, 'Belum Diisi') as education_level_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_education_level el ON e.education_level_id = el.education_level_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY el.education_level_name ORDER BY total DESC`, params
    );

    const [byReligion] = await safeQuery(
      `SELECT COALESCE(r.religion_name, 'Belum Diisi') as religion_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_religion r ON e.religion_id = r.religion_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY r.religion_name ORDER BY total DESC`, params
    );

    const [byMaritalStatus] = await safeQuery(
      `SELECT COALESCE(e.marital_status, 'Belum Diisi') as marital_status, COUNT(*) as total
       FROM mst_employee e
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY e.marital_status ORDER BY total DESC`, params
    );

    const [byJobLevel] = await safeQuery(
      `SELECT COALESCE(jl.job_level_name, 'Belum Diisi') as job_level_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY jl.job_level_name ORDER BY total DESC`, params
    );

    // Top Posisi
    const [byPosition] = await safeQuery(
      `SELECT COALESCE(p.position_name, 'Belum Diisi') as position_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_position p ON e.position_id = p.position_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY p.position_name ORDER BY total DESC LIMIT 8`, params
    );

    // Kelompok Umur
    const [byAgeGroup] = await safeQuery(
      `SELECT
         CASE
           WHEN TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) < 25 THEN '< 25 Tahun'
           WHEN TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 25 AND 34 THEN '25–34'
           WHEN TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 35 AND 44 THEN '35–44'
           WHEN TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 45 AND 54 THEN '45–54'
           WHEN TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) >= 55 THEN '55+'
           ELSE 'Belum Diisi'
         END as age_group,
         COUNT(*) as total
       FROM mst_employee e
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY age_group
       ORDER BY FIELD(age_group,'< 25 Tahun','25–34','35–44','45–54','55+','Belum Diisi')`, params
    );

    // Trend headcount — join per bulan (12 bulan terakhir)
    const [headcountTrend] = await safeQuery(
      `SELECT DATE_FORMAT(e.join_date, '%Y-%m') as month,
              DATE_FORMAT(e.join_date, '%b %Y') as label,
              COUNT(*) as total
       FROM mst_employee e
       WHERE e.is_deleted = 0
         AND e.join_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
         ${companyFilter}
       GROUP BY month, label
       ORDER BY month ASC`, params
    );

    // Rata-rata masa kerja (dalam bulan)
    const [[{ avg_tenure_months }]] = await safeQuery(
      `SELECT ROUND(AVG(TIMESTAMPDIFF(MONTH, e.join_date, IFNULL(e.exit_date, CURDATE()))), 1) as avg_tenure_months
       FROM mst_employee e
       WHERE e.is_deleted = 0 AND e.join_date IS NOT NULL ${companyFilter}`, params
    );

    const recentJoinsParams = req.query.company_id ? [req.query.company_id] : [];
    const recentJoinsFilter = req.query.company_id ? "AND e.company_id = ?" : "";
    const [recentJoins] = await safeQuery(
      `SELECT e.full_name, e.join_date, e.gender, c.company_name, p.position_name, d.department_name, es.employment_status_name
       FROM mst_employee e
       LEFT JOIN mst_company    c  ON e.company_id          = c.company_id
       LEFT JOIN mst_position   p  ON e.position_id         = p.position_id
       LEFT JOIN mst_department d  ON e.department_id       = d.department_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       WHERE e.is_deleted = 0
       AND MONTH(e.join_date) = MONTH(CURDATE()) AND YEAR(e.join_date) = YEAR(CURDATE())
       ${recentJoinsFilter}
       ORDER BY e.join_date DESC LIMIT 8`, recentJoinsParams
    );

    res.json({
      total, active, resigned, contract_ending, incomplete_profile,
      avg_tenure_months,
      byDepartment, byStatus, byCompany, recentJoins,
      byGender, byEducation, byReligion, byMaritalStatus, byJobLevel,
      byPosition, byAgeGroup, headcountTrend
    });
  } catch (err) {
    console.error("getDashboardSummary error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── LIST EMPLOYEES ─────────────────────────────────────────────────────────
export const listEmployees = async (req, res) => {
  try {
    const {
      company_id, department_id, status, search,
      // chart drill-down filters
      gender, marital_status,
      employment_status_name, department_name,
      job_level_name, position_name,
      education_level_name, religion_name,
      age_group, join_month, join_year,
      page = 1, limit = 20
    } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ["e.is_deleted = 0"];
    const params     = [];

    if (company_id)    { conditions.push("e.company_id = ?");    params.push(company_id); }
    if (department_id) { conditions.push("e.department_id = ?"); params.push(department_id); }

    // Status filters
    if (status === "active")   conditions.push("e.exit_date IS NULL AND e.employment_status_id IS NOT NULL");
    if (status === "resigned") conditions.push("e.exit_date IS NOT NULL");
    if (status === "contract_ending") {
      conditions.push("e.contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)");
    }
    if (status === "incomplete_profile") {
      conditions.push("(e.phone_number IS NULL OR e.address IS NULL OR e.ktp_number IS NULL OR e.bank_account_number IS NULL)");
    }

    // Chart drill-down filters
    if (gender) {
      if (gender === "Belum Diisi") { conditions.push("e.gender IS NULL"); }
      else { conditions.push("e.gender = ?"); params.push(gender); }
    }
    if (marital_status) {
      if (marital_status === "Belum Diisi") { conditions.push("e.marital_status IS NULL"); }
      else { conditions.push("e.marital_status = ?"); params.push(marital_status); }
    }
    if (employment_status_name) {
      if (employment_status_name === "Belum Diisi") { conditions.push("e.employment_status_id IS NULL"); }
      else { conditions.push("es.employment_status_name = ?"); params.push(employment_status_name); }
    }
    if (department_name) {
      if (department_name === "Belum Diisi") { conditions.push("e.department_id IS NULL"); }
      else { conditions.push("d.department_name = ?"); params.push(department_name); }
    }
    if (job_level_name) {
      if (job_level_name === "Belum Diisi") { conditions.push("e.job_level_id IS NULL"); }
      else { conditions.push("j.job_level_name = ?"); params.push(job_level_name); }
    }
    if (position_name) {
      if (position_name === "Belum Diisi") { conditions.push("e.position_id IS NULL"); }
      else { conditions.push("p.position_name = ?"); params.push(position_name); }
    }
    if (education_level_name) {
      if (education_level_name === "Belum Diisi") { conditions.push("e.education_level_id IS NULL"); }
      else { conditions.push("el.education_level_name = ?"); params.push(education_level_name); }
    }
    if (religion_name) {
      if (religion_name === "Belum Diisi") { conditions.push("e.religion_id IS NULL"); }
      else { conditions.push("r.religion_name = ?"); params.push(religion_name); }
    }
    if (age_group) {
      const ageMap = {
        "< 25 Tahun": "TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) < 25",
        "25-34":       "TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 25 AND 34",
        "35-44":       "TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 35 AND 44",
        "45-54":       "TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) BETWEEN 45 AND 54",
        ">= 55 Tahun": "TIMESTAMPDIFF(YEAR, e.birth_date, CURDATE()) >= 55",
        "Belum Diisi": "e.birth_date IS NULL",
      };
      const cond = ageMap[age_group];
      if (cond) conditions.push(cond);
    }
    if (join_month && join_year) {
      conditions.push("MONTH(e.join_date) = ? AND YEAR(e.join_date) = ?");
      params.push(parseInt(join_month), parseInt(join_year));
    }

    if (search) {
      conditions.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.ktp_number LIKE ? OR u.username LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = "WHERE " + conditions.join(" AND ");

    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) as total FROM mst_employee e
       LEFT JOIN users                 u  ON u.email              = e.email
       LEFT JOIN mst_company           c  ON e.company_id          = c.company_id
       LEFT JOIN mst_department        d  ON e.department_id       = d.department_id
       LEFT JOIN mst_position          p  ON e.position_id         = p.position_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       LEFT JOIN mst_job_level         j  ON e.job_level_id        = j.job_level_id
       LEFT JOIN mst_education_level   el ON e.education_level_id  = el.education_level_id
       LEFT JOIN mst_religion          r  ON e.religion_id         = r.religion_id
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
       LEFT JOIN mst_education_level   el ON e.education_level_id  = el.education_level_id
       LEFT JOIN mst_religion          r  ON e.religion_id         = r.religion_id
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