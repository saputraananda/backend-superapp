import { safeQuery } from "../../db/pool.js";

export const getDepartments = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_department ORDER BY department_name ASC`);
    res.json({ departments: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getDepartmentById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_department WHERE department_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Departemen tidak ditemukan" });
    res.json({ department: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createDepartment = async (req, res) => {
  const { company_code, department_name, is_active = 1 } = req.body;
  if (!department_name?.trim()) return res.status(400).json({ message: "Nama departemen wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_department (company_code, department_name, is_active) VALUES (?, ?, ?)`,
      [company_code?.trim() || null, department_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Departemen berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateDepartment = async (req, res) => {
  const { company_code, department_name, is_active } = req.body;
  if (!department_name?.trim()) return res.status(400).json({ message: "Nama departemen wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_department SET company_code = ?, department_name = ?, is_active = ? WHERE department_id = ?`,
      [company_code?.trim() || null, department_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Departemen berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteDepartment = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_department WHERE department_id = ?`, [req.params.id]);
    res.json({ message: "Departemen berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
