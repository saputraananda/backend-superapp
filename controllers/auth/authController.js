import express from "express";
import { safeQuery } from "../../db/pool.js";
import bcrypt from "bcrypt";

const router = express.Router();

// REGISTER
export async function register(req, res) {
  const { name, full_name, email, password } = req.body;

  const finalFullName = full_name ?? name;
  if (!finalFullName) return res.status(400).json({ message: "Full name is required" });
  if (!email)         return res.status(400).json({ message: "Email is required" });
  if (!password)      return res.status(400).json({ message: "Password is required" });

  try {
    const [exist] = await safeQuery(`SELECT id FROM users WHERE email = ?`, [email]);
    if (exist.length > 0) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await safeQuery(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [finalFullName, email, password_hash, "employee"]
    );

    await safeQuery(
      `INSERT INTO mst_employee (full_name, email) VALUES (?, ?)`,
      [finalFullName, email]
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
    const [rows] = await safeQuery(
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

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const [empRows] = await safeQuery(
      `SELECT * FROM mst_employee WHERE email = ? AND is_deleted = 0`,
      [email]
    );

    const employee = empRows[0] || null;

    req.session.userId       = user.id;
    req.session.userEmail    = user.email;
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
      "SELECT id, name, email, role FROM users WHERE id = ?",
      [req.session.userId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = rows[0];

    const [empRows] = await safeQuery(
      `SELECT 
         e.*,
         c.company_name,
         d.department_name,
         jl.job_level_name,
         p.position_name
       FROM mst_employee e
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