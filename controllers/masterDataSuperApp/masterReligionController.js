import { safeQuery } from "../../db/pool.js";

export const getReligions = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_religion ORDER BY religion_name ASC`);
    res.json({ religions: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getReligionById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_religion WHERE religion_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Agama tidak ditemukan" });
    res.json({ religion: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createReligion = async (req, res) => {
  const { religion_name, is_active = 1 } = req.body;
  if (!religion_name?.trim()) return res.status(400).json({ message: "Nama agama wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_religion (religion_name, is_active) VALUES (?, ?)`,
      [religion_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Agama berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateReligion = async (req, res) => {
  const { religion_name, is_active } = req.body;
  if (!religion_name?.trim()) return res.status(400).json({ message: "Nama agama wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_religion SET religion_name = ?, is_active = ? WHERE religion_id = ?`,
      [religion_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Agama berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteReligion = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_religion WHERE religion_id = ?`, [req.params.id]);
    res.json({ message: "Agama berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
