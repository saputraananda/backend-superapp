import { safeQuery } from "../../db/pool.js";

export const getPositions = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_position ORDER BY position_name ASC`);
    res.json({ positions: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getPositionById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_position WHERE position_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Posisi tidak ditemukan" });
    res.json({ position: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createPosition = async (req, res) => {
  const { company_code, position_name, is_active = 1 } = req.body;
  if (!position_name?.trim()) return res.status(400).json({ message: "Nama posisi wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_position (company_code, position_name, is_active) VALUES (?, ?, ?)`,
      [company_code?.trim() || null, position_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Posisi berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updatePosition = async (req, res) => {
  const { company_code, position_name, is_active } = req.body;
  if (!position_name?.trim()) return res.status(400).json({ message: "Nama posisi wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_position SET company_code = ?, position_name = ?, is_active = ? WHERE position_id = ?`,
      [company_code?.trim() || null, position_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Posisi berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deletePosition = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_position WHERE position_id = ?`, [req.params.id]);
    res.json({ message: "Posisi berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
