import { safeQuery } from "../../db/pool.js";

export const getEducationLevels = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_education_level ORDER BY education_level_name ASC`);
    res.json({ educationLevels: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getEducationLevelById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_education_level WHERE education_level_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Tingkat pendidikan tidak ditemukan" });
    res.json({ educationLevel: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createEducationLevel = async (req, res) => {
  const { education_level_name, is_active = 1 } = req.body;
  if (!education_level_name?.trim()) return res.status(400).json({ message: "Nama tingkat pendidikan wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_education_level (education_level_name, is_active) VALUES (?, ?)`,
      [education_level_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Tingkat pendidikan berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateEducationLevel = async (req, res) => {
  const { education_level_name, is_active } = req.body;
  if (!education_level_name?.trim()) return res.status(400).json({ message: "Nama tingkat pendidikan wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_education_level SET education_level_name = ?, is_active = ? WHERE education_level_id = ?`,
      [education_level_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Tingkat pendidikan berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteEducationLevel = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_education_level WHERE education_level_id = ?`, [req.params.id]);
    res.json({ message: "Tingkat pendidikan berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
