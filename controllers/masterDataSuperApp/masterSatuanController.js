import { safeQuery } from "../../db/pool.js";

export const getAll = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_satuan ORDER BY satuan_name ASC`);
    res.json({ satuan: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_satuan WHERE satuan_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Satuan tidak ditemukan" });
    res.json({ satuan: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const create = async (req, res) => {
  const { satuan_name, is_active = 1 } = req.body;
  if (!satuan_name?.trim()) return res.status(400).json({ message: "Nama satuan wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_satuan (satuan_name, is_active) VALUES (?, ?)`,
      [satuan_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Satuan berhasil ditambahkan", id: r.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Nama satuan sudah ada" });
    res.status(500).json({ message: err.message });
  }
};

export const update = async (req, res) => {
  const { satuan_name, is_active } = req.body;
  if (!satuan_name?.trim()) return res.status(400).json({ message: "Nama satuan wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_satuan SET satuan_name = ?, is_active = ? WHERE satuan_id = ?`,
      [satuan_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Satuan berhasil diperbarui" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Nama satuan sudah ada" });
    res.status(500).json({ message: err.message });
  }
};

export const remove = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_satuan WHERE satuan_id = ?`, [req.params.id]);
    res.json({ message: "Satuan berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
