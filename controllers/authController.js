import express from "express";
import pool from "../db/pool.js";
import bcrypt from "bcrypt";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Get employee profile by email
router.get("/profile", requireAuth, async (req, res) => {
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
});

// Update employee profile
router.put("/profile", requireAuth, async (req, res) => {
  const {
    full_name, gender, birth_place, birth_date, address, ktp_number,
    family_card_number, phone_number, company_id, position_id,
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
        phone_number = ?, company_id = ?, position_id = ?,
        department_id = ?, join_date = ?, employment_status_id = ?,
        contract_end_date = ?, education_level_id = ?, school_name = ?,
        religion_id = ?, marital_status = ?, bpjs_health_number = ?,
        bpjs_employment_number = ?, npwp_number = ?, bank_id = ?,
        bank_account_number = ?, emergency_contact = ?, notes = ?
      WHERE email = ? AND is_deleted = 0`,
      [
        full_name, gender, birth_place, birth_date, address, ktp_number,
        family_card_number, phone_number, company_id, position_id,
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
});

// Get master data for dropdowns - TIDAK PERLU AUTH
router.get("/master-data", async (req, res) => {
  try {
    const [companies] = await pool.query("SELECT * FROM mst_company WHERE is_active = 1");
    const [departments] = await pool.query("SELECT * FROM mst_department WHERE is_active = 1");
    const [positions] = await pool.query("SELECT * FROM mst_position WHERE is_active = 1");
    const [employmentStatuses] = await pool.query("SELECT * FROM mst_employment_status WHERE is_active = 1");
    const [educationLevels] = await pool.query("SELECT * FROM mst_education_level WHERE is_active = 1");
    const [religions] = await pool.query("SELECT * FROM mst_religion WHERE is_active = 1");
    const [banks] = await pool.query("SELECT * FROM mst_bank WHERE is_active = 1");

    res.json({
      companies,
      departments,
      positions,
      employmentStatuses,
      educationLevels,
      religions,
      banks
    });
  } catch (error) {
    console.error("Get master data error:", error);
    res.status(500).json({ message: error.message });
  }
});

// REGISTER
export async function register(req, res) {
  const { full_name, gender, birth_place, birth_date, address, ktp_number,
    family_card_number, phone_number, company_id, position_id,
    department_id, join_date, employment_status_id, contract_end_date,
    education_level_id, school_name, religion_id, marital_status,
    bpjs_health_number, bpjs_employment_number, npwp_number,
    bank_id, bank_account_number, emergency_contact, notes }
    = req.body;

  try {
    await pool.query(
      `INSERT INTO mst_employee (full_name, gender, birth_place, birth_date, address, ktp_number, family_card_number, phone_number, company_id, position_id, department_id, join_date, employment_status_id, contract_end_date, education_level_id, school_name, religion_id, marital_status, bpjs_health_number, bpjs_employment_number, npwp_number, bank_id, bank_account_number, emergency_contact, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        full_name, gender, birth_place, birth_date, address, ktp_number,
        family_card_number, phone_number, company_id, position_id,
        department_id, join_date, employment_status_id, contract_end_date,
        education_level_id, school_name, religion_id, marital_status,
        bpjs_health_number, bpjs_employment_number, npwp_number,
        bank_id, bank_account_number, emergency_contact, notes
      ]
    );

    res.json({ message: "Registration successful" });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ message: error.message });
  }
}

// LOGIN
export async function login(req, res) {
  const { email, password } = req.body;

  try {
    // Cari user di tabel users
    const [rows] = await pool.query(
      `SELECT * FROM users WHERE email = ?`,
      [email]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const user = rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Bandingkan password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    // Ambil data employee (jika ada)
    const [empRows] = await pool.query(
      `SELECT * FROM mst_employee WHERE email = ? AND is_deleted = 0`,
      [email]
    );

    // Set session
    req.session.userId = user.id;
    req.session.userEmail = user.email;

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        employee: empRows[0] || null
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: error.message });
  }
}

// LOGOUT
export async function logout(req, res) {
  req.session.userEmail = null;
  res.json({ message: "Logout successful" });
}

// ME
export async function me(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const [rows] = await pool.query("SELECT id, name, email, role FROM users WHERE id = ?", [req.session.userId]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // Ambil data employee
    const [empRows] = await pool.query(
      "SELECT * FROM mst_employee WHERE email = ? AND is_deleted = 0",
      [user.email]
    );

    res.json({
      user: {
        ...user,
        employee: empRows[0] || null
      }
    });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ message: error.message });
  }
}

export default router;