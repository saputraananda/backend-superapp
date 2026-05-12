import { safeQuery } from "../../db/pool.js";

export const getEmployeeStatuses = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_employment_status ORDER BY employment_status_name ASC`);
    res.json({ employeeStatuses: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getEmployeeStatusById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_employment_status WHERE employment_status_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Status karyawan tidak ditemukan" });
    res.json({ employeeStatus: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createEmployeeStatus = async (req, res) => {
  const { employment_status_name, is_active = 1 } = req.body;
  if (!employment_status_name?.trim()) return res.status(400).json({ message: "Nama status karyawan wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_employment_status (employment_status_name, is_active) VALUES (?, ?)`,
      [employment_status_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Status karyawan berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateEmployeeStatus = async (req, res) => {
  const { employment_status_name, is_active } = req.body;
  if (!employment_status_name?.trim()) return res.status(400).json({ message: "Nama status karyawan wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_employment_status SET employment_status_name = ?, is_active = ? WHERE employment_status_id = ?`,
      [employment_status_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Status karyawan berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteEmployeeStatus = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_employment_status WHERE employment_status_id = ?`, [req.params.id]);
    res.json({ message: "Status karyawan berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
