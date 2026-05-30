import { safeQuery } from "../../db/pool.js";

export const getOutlets = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_outlet ORDER BY name ASC`);
    res.json({ outlets: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getOutletById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_outlet WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Outlet tidak ditemukan" });
    res.json({ outlet: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createOutlet = async (req, res) => {
  const { name, full_name, address = "", lat, lon } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "Nama outlet wajib diisi" });
  if (!full_name?.trim()) return res.status(400).json({ message: "Nama lengkap outlet wajib diisi" });
  if (lat == null || lon == null) return res.status(400).json({ message: "Koordinat lat/lon wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_outlet (name, full_name, address, lat, lon) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), full_name.trim(), address.trim(), Number(lat), Number(lon)]
    );
    res.status(201).json({ message: "Outlet berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateOutlet = async (req, res) => {
  const { name, full_name, address, lat, lon } = req.body;
  if (!name?.trim()) return res.status(400).json({ message: "Nama outlet wajib diisi" });
  if (!full_name?.trim()) return res.status(400).json({ message: "Nama lengkap outlet wajib diisi" });
  if (lat == null || lon == null) return res.status(400).json({ message: "Koordinat lat/lon wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_outlet SET name = ?, full_name = ?, address = ?, lat = ?, lon = ? WHERE id = ?`,
      [name.trim(), full_name.trim(), (address || "").trim(), Number(lat), Number(lon), req.params.id]
    );
    res.json({ message: "Outlet berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteOutlet = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_outlet WHERE id = ?`, [req.params.id]);
    res.json({ message: "Outlet berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
