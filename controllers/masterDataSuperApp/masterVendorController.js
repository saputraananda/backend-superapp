import { safeQuery } from "../../db/pool.js";

export const getAll = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_vendor ORDER BY nama_vendor ASC`);
    res.json({ vendors: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_vendor WHERE id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Vendor tidak ditemukan" });
    res.json({ vendor: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

function generateId() {
  // Generate random ID — tabel mst_vendor tidak pakai AUTO_INCREMENT
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return Number(ts.slice(-4) + rand.charCodeAt(0).toString().padStart(3, "0"));
}

export const create = async (req, res) => {
  const { nama_vendor, kategori, alamat, kontak_person, no_telepon_1, no_telepon_2, email, status, catatan_tambahan, pengiriman } = req.body;
  if (!nama_vendor?.trim()) return res.status(400).json({ message: "Nama vendor wajib diisi" });
  if (!kategori?.trim()) return res.status(400).json({ message: "Kategori wajib diisi" });
  try {
    const id = generateId();
    await safeQuery(
      `INSERT INTO mst_vendor (id, nama_vendor, kategori, alamat, kontak_person, no_telepon_1, no_telepon_2, email, status, catatan_tambahan, pengiriman)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, nama_vendor.trim(), kategori.trim(), alamat || null, kontak_person || null, no_telepon_1 || null, no_telepon_2 || null, email || null, status || "AKTIF", catatan_tambahan || null, pengiriman || null]
    );
    res.status(201).json({ message: "Vendor berhasil ditambahkan", id });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const update = async (req, res) => {
  const { nama_vendor, kategori, alamat, kontak_person, no_telepon_1, no_telepon_2, email, status, catatan_tambahan, pengiriman } = req.body;
  if (!nama_vendor?.trim()) return res.status(400).json({ message: "Nama vendor wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_vendor SET nama_vendor = ?, kategori = ?, alamat = ?, kontak_person = ?, no_telepon_1 = ?, no_telepon_2 = ?, email = ?, status = ?, catatan_tambahan = ?, pengiriman = ? WHERE id = ?`,
      [nama_vendor.trim(), kategori.trim(), alamat || null, kontak_person || null, no_telepon_1 || null, no_telepon_2 || null, email || null, status || "AKTIF", catatan_tambahan || null, pengiriman || null, req.params.id]
    );
    res.json({ message: "Vendor berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const remove = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_vendor WHERE id = ?`, [req.params.id]);
    res.json({ message: "Vendor berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
