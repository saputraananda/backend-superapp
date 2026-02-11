import pool from "../db/pool.js";

export const getEmployees = async (req, res) => {
  const [rows] = await pool.query(`SELECT * FROM employees ORDER BY id DESC LIMIT 100`);
  res.json({ employees: rows });
};

export const createEmployee = async (req, res) => {
  const { 
    employee_code, 
    name, email, 
    department, 
    position, 
    join_date, 
    is_active = 1 } = req.body;
    
  if (!employee_code || !name) return res.status(400).json({ message: "employee_code & name required" });

  await pool.query(
    `INSERT INTO employees (employee_code, name, email, department, position, join_date, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [employee_code, name, email ?? null, department ?? null, position ?? null, join_date ?? null, is_active ? 1 : 0]
  );

  res.json({ ok: true });
};