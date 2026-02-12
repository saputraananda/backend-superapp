import pool from "../db/pool.js";

// Get employee profile with joins to related master tables
export const getProfile = async (req, res) => {
  console.log("[API] /employees/profile endpoint hit");

  if (!req.session.userEmail) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const [rows] = await pool.query(
      `SELECT e.*, 
        c.company_name, 
        j.job_level_name, 
        p.position_name, 
        d.department_name,
        es.employment_status_name,
        ed.education_level_name,
        r.religion_name,
        b.bank_name
      FROM mst_employee e
      LEFT JOIN mst_company c ON e.company_id = c.company_id
      LEFT JOIN mst_job_level j ON e.job_level_id = j.job_level_id
      LEFT JOIN mst_position p ON e.position_id = p.position_id
      LEFT JOIN mst_department d ON e.department_id = d.department_id
      LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
      LEFT JOIN mst_education_level ed ON e.education_level_id = ed.education_level_id
      LEFT JOIN mst_religion r ON e.religion_id = r.religion_id
      LEFT JOIN mst_bank b ON e.bank_id = b.bank_id
      WHERE e.email = ? AND e.is_deleted = 0`,
      [req.session.userEmail]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Employee not found" });
    }

    res.json({ employee: rows[0] });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ message: error.message });
  }
};

export const updateProfile = async (req, res) => {
  console.log("[API] PUT /employees/profile endpoint hit");

  if (!req.session.userEmail) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const {
    full_name, gender, birth_place, birth_date, address, ktp_number,
    family_card_number, phone_number, company_id, job_level_id, position_id,
    department_id, join_date, employment_status_id, contract_end_date,
    education_level_id, school_name, religion_id, marital_status,
    bpjs_health_number, bpjs_employment_number, npwp_number,
    bank_id, bank_account_number, emergency_contact, notes
  } = req.body;

  try {
    await pool.query(
      `UPDATE mst_employee SET
        full_name = ?, gender = ?, birth_place = ?, birth_date = ?,
        address = ?, ktp_number = ?, family_card_number = ?,
        phone_number = ?, company_id = ?, job_level_id = ?, position_id = ?,
        department_id = ?, join_date = ?, employment_status_id = ?,
        contract_end_date = ?, education_level_id = ?, school_name = ?,
        religion_id = ?, marital_status = ?, bpjs_health_number = ?,
        bpjs_employment_number = ?, npwp_number = ?, bank_id = ?,
        bank_account_number = ?, emergency_contact = ?, notes = ?
      WHERE email = ? AND is_deleted = 0`,
      [
        full_name, gender, birth_place, birth_date, address, ktp_number,
        family_card_number, phone_number, company_id, job_level_id, position_id,
        department_id, join_date, employment_status_id, contract_end_date,
        education_level_id, school_name, religion_id, marital_status,
        bpjs_health_number, bpjs_employment_number, npwp_number,
        bank_id, bank_account_number, emergency_contact, notes,
        req.session.userEmail
      ]
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Get master data for employee profile dropdownsq
export const getMasterData = async (req, res) => {
  console.log("[API] /employees/master-data endpoint hit");

  try {
    const [companies] = await pool.query("SELECT * FROM mst_company WHERE is_active = 1");
    const [departments] = await pool.query("SELECT * FROM mst_department WHERE is_active = 1");
    const [positions] = await pool.query("SELECT * FROM mst_position WHERE is_active = 1");
    const [jobLevels] = await pool.query("SELECT * FROM mst_job_level WHERE is_active = 1");
    const [employmentStatuses] = await pool.query("SELECT * FROM mst_employment_status WHERE is_active = 1");
    const [educationLevels] = await pool.query("SELECT * FROM mst_education_level WHERE is_active = 1");
    const [religions] = await pool.query("SELECT * FROM mst_religion WHERE is_active = 1");
    const [banks] = await pool.query("SELECT * FROM mst_bank WHERE is_active = 1");

    res.json({
      companies,
      departments,
      positions,
      jobLevels,
      employmentStatuses,
      educationLevels,
      religions,
      banks
    });
  } catch (error) {
    console.error("Get master data error:", error);
    res.status(500).json({ message: error.message });
  }
};