import pool from "../db/pool.js";

// ── DASHBOARD SUMMARY ──────────────────────────────────────────────────────
export const getDashboardSummary = async (req, res) => {
  try {
    const companyFilter = req.query.company_id ? "AND e.company_id = ?" : "";
    const params = req.query.company_id ? [req.query.company_id] : [];

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM mst_employee e WHERE e.is_deleted = 0 ${companyFilter}`, params
    );
    const [[{ active }]] = await pool.query(
      `SELECT COUNT(*) as active FROM mst_employee e WHERE e.is_deleted = 0 AND e.employment_status_id IS NOT NULL ${companyFilter}`, params
    );
    const [[{ resigned }]] = await pool.query(
      `SELECT COUNT(*) as resigned FROM mst_employee e WHERE e.is_deleted = 0 AND e.exit_date IS NOT NULL ${companyFilter}`, params
    );
    const [[{ contract_ending }]] = await pool.query(
      `SELECT COUNT(*) as contract_ending FROM mst_employee e
       WHERE e.is_deleted = 0 AND e.contract_end_date IS NOT NULL
       AND e.contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       ${companyFilter}`, params
    );
    const [[{ incomplete_profile }]] = await pool.query(
      `SELECT COUNT(*) as incomplete_profile FROM mst_employee e
       WHERE e.is_deleted = 0
       AND (e.phone_number IS NULL OR e.address IS NULL OR e.ktp_number IS NULL OR e.bank_account_number IS NULL)
       ${companyFilter}`, params
    );

    // Per department
    const [byDepartment] = await pool.query(
      `SELECT d.department_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY d.department_name ORDER BY total DESC`, params
    );

    // Per employment status
    const [byStatus] = await pool.query(
      `SELECT es.employment_status_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       WHERE e.is_deleted = 0 ${companyFilter}
       GROUP BY es.employment_status_name ORDER BY total DESC`, params
    );

    // Per company
    const [byCompany] = await pool.query(
      `SELECT c.company_name, COUNT(*) as total
       FROM mst_employee e
       LEFT JOIN mst_company c ON e.company_id = c.company_id
       WHERE e.is_deleted = 0
       GROUP BY c.company_name ORDER BY total DESC`
    );

    // Join this month
    const [recentJoins] = await pool.query(
      `SELECT e.full_name, e.join_date, c.company_name, p.position_name, d.department_name
       FROM mst_employee e
       LEFT JOIN mst_company c ON e.company_id = c.company_id
       LEFT JOIN mst_position p ON e.position_id = p.position_id
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0 AND MONTH(e.join_date) = MONTH(CURDATE()) AND YEAR(e.join_date) = YEAR(CURDATE())
       ${companyFilter}
       ORDER BY e.join_date DESC LIMIT 5`, params
    );

    res.json({ total, active, resigned, contract_ending, incomplete_profile, byDepartment, byStatus, byCompany, recentJoins });
  } catch (err) {
    console.error("getDashboardSummary error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── LIST EMPLOYEES (with filter + pagination) ──────────────────────────────
export const listEmployees = async (req, res) => {
  try {
    const { company_id, department_id, status, search, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const conditions = ["e.is_deleted = 0"];
    const params = [];

    if (company_id)    { conditions.push("e.company_id = ?");    params.push(company_id); }
    if (department_id) { conditions.push("e.department_id = ?"); params.push(department_id); }
    if (status === "active")   conditions.push("e.exit_date IS NULL");
    if (status === "resigned") conditions.push("e.exit_date IS NOT NULL");
    if (status === "contract_ending") {
      conditions.push("e.contract_end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)");
    }
    if (search) {
      conditions.push("(e.full_name LIKE ? OR e.email LIKE ? OR e.ktp_number LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const where = "WHERE " + conditions.join(" AND ");

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM mst_employee e ${where}`, params
    );

    const [rows] = await pool.query(
      `SELECT
        e.employee_id, e.full_name, e.email, e.phone_number,
        e.join_date, e.contract_end_date, e.exit_date,
        e.profile_path,
        e.gender, e.birth_place, e.birth_date, e.address,
        e.ktp_number, e.family_card_number, e.religion_id,
        e.marital_status, e.company_id, e.department_id,
        e.position_id, e.employment_status_id,
        e.education_level_id, e.school_name, e.bank_id,
        e.bank_account_number, e.bpjs_health_number,
        e.bpjs_employment_number, e.npwp_number,
        e.emergency_contact, e.notes, e.ktp_path,
        c.company_name, d.department_name, p.position_name,
        es.employment_status_name, j.job_level_name
       FROM mst_employee e
       LEFT JOIN mst_company c ON e.company_id = c.company_id
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       LEFT JOIN mst_position p ON e.position_id = p.position_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       LEFT JOIN mst_job_level j ON e.job_level_id = j.job_level_id
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

// ── GET SINGLE EMPLOYEE (HR view) ──────────────────────────────────────────
export const getEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT e.*,
        c.company_name, d.department_name, p.position_name,
        j.job_level_name, es.employment_status_name,
        ed.education_level_name, r.religion_name, b.bank_name
       FROM mst_employee e
       LEFT JOIN mst_company c ON e.company_id = c.company_id
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       LEFT JOIN mst_position p ON e.position_id = p.position_id
       LEFT JOIN mst_job_level j ON e.job_level_id = j.job_level_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       LEFT JOIN mst_education_level ed ON e.education_level_id = ed.education_level_id
       LEFT JOIN mst_religion r ON e.religion_id = r.religion_id
       LEFT JOIN mst_bank b ON e.bank_id = b.bank_id
       WHERE e.employee_id = ? AND e.is_deleted = 0`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });
    res.json({ employee: rows[0] });
  } catch (err) {
    console.error("getEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE EMPLOYEE (HR) ───────────────────────────────────────────────────
export const updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      full_name, gender, birth_place, birth_date, address, ktp_number,
      family_card_number, phone_number, company_id, job_level_id, position_id,
      department_id, join_date, employment_status_id, contract_end_date,
      exit_date, exit_reason, education_level_id, school_name, religion_id,
      marital_status, bpjs_health_number, bpjs_employment_number, npwp_number,
      bank_id, bank_account_number, emergency_contact, notes
    } = req.body;

    await pool.query(
      `UPDATE mst_employee SET
        full_name = ?, gender = ?, birth_place = ?, birth_date = ?,
        address = ?, ktp_number = ?, family_card_number = ?,
        phone_number = ?, company_id = ?, job_level_id = ?, position_id = ?,
        department_id = ?, join_date = ?, employment_status_id = ?,
        contract_end_date = ?, exit_date = ?, exit_reason = ?,
        education_level_id = ?, school_name = ?, religion_id = ?,
        marital_status = ?, bpjs_health_number = ?, bpjs_employment_number = ?,
        npwp_number = ?, bank_id = ?, bank_account_number = ?,
        emergency_contact = ?, notes = ?
       WHERE employee_id = ? AND is_deleted = 0`,
      [
        full_name, gender, birth_place, birth_date, address, ktp_number,
        family_card_number, phone_number, company_id, job_level_id, position_id,
        department_id, join_date, employment_status_id, contract_end_date,
        exit_date || null, exit_reason || null,
        education_level_id, school_name, religion_id, marital_status,
        bpjs_health_number, bpjs_employment_number, npwp_number,
        bank_id, bank_account_number, emergency_contact, notes, id
      ]
    );

    res.json({ message: "Data karyawan berhasil diperbarui." });
  } catch (err) {
    console.error("updateEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── SOFT DELETE EMPLOYEE ───────────────────────────────────────────────────
export const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query(
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

    await pool.query(
      "UPDATE mst_employee SET exit_date = ?, exit_reason = ? WHERE employee_id = ? AND is_deleted = 0",
      [exit_date, exit_reason || null, id]
    );
    res.json({ message: "Status karyawan berhasil diperbarui." });
  } catch (err) {
    console.error("resignEmployee error:", err);
    res.status(500).json({ message: err.message });
  }
};