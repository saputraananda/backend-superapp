import { safeQuery } from "../../db/pool.js";

export const getBanks = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_bank ORDER BY bank_name ASC`);
    res.json({ banks: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getBankById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_bank WHERE bank_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Bank tidak ditemukan" });
    res.json({ bank: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createBank = async (req, res) => {
  const { bank_name, is_active = 1 } = req.body;
  if (!bank_name?.trim()) return res.status(400).json({ message: "Nama bank wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_bank (bank_name, is_active) VALUES (?, ?)`,
      [bank_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Bank berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateBank = async (req, res) => {
  const { bank_name, is_active } = req.body;
  if (!bank_name?.trim()) return res.status(400).json({ message: "Nama bank wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_bank SET bank_name = ?, is_active = ? WHERE bank_id = ?`,
      [bank_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Bank berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteBank = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_bank WHERE bank_id = ?`, [req.params.id]);
    res.json({ message: "Bank berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
