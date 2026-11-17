import express from "express";
import { safeQuery } from "../../db/pool.js";
import bcrypt from "bcrypt";

const router = express.Router();

const REMEMBER_ME_MS = 1000 * 60 * 60 * 24 * 30; // 30 hari

// LOGIN
export async function login(req, res) {
  const { email, password, identifier } = req.body;

  // identifier bisa email atau username
  const loginIdentifier = identifier || email;

  if (!loginIdentifier) {
    return res.status(400).json({ message: "Email atau username wajib diisi" });
  }

  try {
    // Cari user berdasarkan email ATAU username
    const [rows] = await safeQuery(
      `SELECT * FROM users WHERE email = ? OR username = ? LIMIT 1`,
      [loginIdentifier, loginIdentifier]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "Email/username atau password salah" });
    }

    const user = rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ message: "Email/username atau password salah" });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Email/username atau password salah" });
    }

    const [empRows] = await safeQuery(
      `SELECT e.*,
              b.bank_name
       FROM mst_employee e
       LEFT JOIN mst_bank b ON b.bank_id = e.bank_id
       WHERE e.email = ? AND e.is_deleted = 0 AND exit_date IS NULL`,
      [user.email]
    );

    if (!empRows[0]) {
      return res.status(403).json({ message: "Akun tidak aktif atau tidak terdaftar sebagai karyawan" });
    }

    const employee = empRows[0];

    // "Ingat saya": sesi bertahan 30 hari (diperpanjang tiap ada aktivitas, karena rolling: true).
    // Tanpa centang: tetap default 2 jam dari konfigurasi session di index.js.
    if (req.body.remember === true) {
      req.session.cookie.maxAge = REMEMBER_ME_MS;
    }

    req.session.userId       = user.id;
    req.session.userEmail    = user.email;
    req.session.userName     = user.username;
    req.session.userRole     = user.role;

    if (employee) {
      req.session.employeeId    = employee.employee_id;
      req.session.employee_code = employee.employee_code;
    }

    res.json({
      message: "Login successful",
      user: {
        id:       user.id,
        name:     user.name,
        email:    user.email,
        username: user.username,
        role:     user.role,
        employee: employee,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: error.message });
  }
}

// LOGOUT
export async function logout(req, res) {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: "Logout failed" });
    res.json({ message: "Logout successful" });
  });
}

// ME
export async function me(req, res) {
  if (!req.session.userId) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const [rows] = await safeQuery(
      "SELECT id, name, email, username, role FROM users WHERE id = ?",
      [req.session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    // Sync session username kalau belum ada
    if (!req.session.userName && user.username) {
      req.session.userName = user.username;
    }

    const [empRows] = await safeQuery(
      `SELECT 
         e.*,
         b.bank_name,
         c.company_name,
         d.department_name,
         jl.job_level_name,
         p.position_name
       FROM mst_employee e
       LEFT JOIN mst_bank       b  ON b.bank_id       = e.bank_id
       LEFT JOIN mst_company    c  ON c.company_id    = e.company_id
       LEFT JOIN mst_department d  ON d.department_id = e.department_id
       LEFT JOIN mst_job_level  jl ON jl.job_level_id = e.job_level_id
       LEFT JOIN mst_position   p  ON p.position_id   = e.position_id
       WHERE e.email = ? AND e.is_deleted = 0
       LIMIT 1`,
      [user.email]
    );

    res.json({
      user: {
        ...user,
        employee: empRows[0] || null,
      },
    });
  } catch (error) {
    console.error("Me error:", error);
    res.status(500).json({ message: error.message });
  }
}

export default router;