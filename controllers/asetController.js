import { safeQuery } from "../db/pool.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(__dirname, "..", "assets");
const ASET_PHOTO_DIR = path.join(BASE_DIR, "aset_photos");

// ── Helper: generate kode_aset ──────────────────────────────────────────
async function generateKodeAset() {
  const [[{ maxId }]] = await safeQuery("SELECT COALESCE(MAX(id), 0) AS maxId FROM mst_aset");
  const next = maxId + 1;
  return `AST-${String(next).padStart(5, "0")}`;
}

// ── GET /aset/master-data — dropdown data ───────────────────────────────
export const getMasterData = async (_req, res) => {
  try {
    const [companies] = await safeQuery(
      "SELECT company_id, company_name FROM mst_company ORDER BY company_name"
    );
    const [employees] = await safeQuery(
      "SELECT employee_id, full_name, position_name FROM mst_employee e LEFT JOIN mst_position p ON e.position_id = p.position_id WHERE e.is_deleted = 0 ORDER BY full_name"
    );
    res.json({ companies, employees });
  } catch (err) {
    console.error("getMasterData error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset — list all (with filter, search, pagination) ──────────────
export const getAsets = async (req, res) => {
  try {
    const {
      search = "",
      sub_kategori = "",
      kondisi = "",
      company_id = "",
      page = 1,
      limit = 20,
    } = req.query;

    let where = "a.is_deleted = 0";
    const params = [];

    if (search) {
      where += " AND (a.kode_aset LIKE ? OR a.nama_aset LIKE ? OR a.brand LIKE ? OR a.no_seri LIKE ?)";
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (sub_kategori) {
      where += " AND a.sub_kategori = ?";
      params.push(sub_kategori);
    }
    if (kondisi) {
      where += " AND a.kondisi = ?";
      params.push(kondisi);
    }
    if (company_id) {
      where += " AND a.company_id = ?";
      params.push(Number(company_id));
    }

    const offset = (Number(page) - 1) * Number(limit);

    // Count
    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) AS total FROM mst_aset a WHERE ${where}`,
      params
    );

    // Data
    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       WHERE ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    // Photos count per asset
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const [photos] = await safeQuery(
        `SELECT aset_id, COUNT(*) AS cnt FROM aset_photos WHERE aset_id IN (?) GROUP BY aset_id`,
        [ids]
      );
      const photoMap = {};
      photos.forEach((p) => (photoMap[p.aset_id] = p.cnt));
      rows.forEach((r) => (r.photo_count = photoMap[r.id] || 0));
    }

    res.json({
      asets: rows,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (err) {
    console.error("getAsets error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/stats — summary ───────────────────────────────────────────
export const getStats = async (_req, res) => {
  try {
    const [[{ total }]] = await safeQuery(
      "SELECT COUNT(*) AS total FROM mst_aset WHERE is_deleted = 0"
    );
    const [byKondisi] = await safeQuery(
      "SELECT kondisi, COUNT(*) AS cnt FROM mst_aset WHERE is_deleted = 0 GROUP BY kondisi"
    );
    const [bySubKategori] = await safeQuery(
      "SELECT sub_kategori, COUNT(*) AS cnt FROM mst_aset WHERE is_deleted = 0 GROUP BY sub_kategori"
    );
    res.json({ total, byKondisi, bySubKategori });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/:id — detail single asset ─────────────────────────────────
export const getAsetById = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       WHERE a.id = ? AND a.is_deleted = 0`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    const [photos] = await safeQuery(
      "SELECT * FROM aset_photos WHERE aset_id = ? ORDER BY created_at",
      [req.params.id]
    );

    res.json({ aset: { ...rows[0], photos } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/kode/:kode — find by kode_aset (QR scan) ──────────────────
export const getAsetByKode = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       WHERE a.kode_aset = ? AND a.is_deleted = 0`,
      [req.params.kode]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset dengan kode tersebut tidak ditemukan" });

    const [photos] = await safeQuery(
      "SELECT * FROM aset_photos WHERE aset_id = ? ORDER BY created_at",
      [rows[0].id]
    );

    res.json({ aset: { ...rows[0], photos } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset — create ─────────────────────────────────────────────────
export const createAset = async (req, res) => {
  const {
    kode_aset, nama_aset, company_id, sub_kategori, brand, model,
    no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan,
    pic_employee_id, kondisi, is_active,
  } = req.body;

  if (!nama_aset?.trim()) return res.status(400).json({ message: "Nama aset wajib diisi" });
  if (!sub_kategori) return res.status(400).json({ message: "Sub kategori wajib dipilih" });

  try {
    // Auto-generate kode jika tidak diisi
    const finalKode = kode_aset?.trim() || (await generateKodeAset());

    // Cek kode duplikat
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE kode_aset = ?", [finalKode]);
    if (exist.length > 0) return res.status(409).json({ message: "Kode aset sudah digunakan" });

    const [result] = await safeQuery(
      `INSERT INTO mst_aset (kode_aset, nama_aset, company_id, sub_kategori, brand, model,
        no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan, pic_employee_id, kondisi, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        finalKode, nama_aset, company_id || null, sub_kategori, brand || null,
        model || null, no_seri || null, lokasi_nama || null,
        lokasi_lat || null, lokasi_lng || null, jumlah || 1,
        satuan || "Unit", pic_employee_id || null, kondisi || "Baik", is_active !== undefined ? (is_active ? 1 : 0) : 1,
      ]
    );

    res.status(201).json({
      message: "Aset berhasil ditambahkan",
      id: result.insertId,
      kode_aset: finalKode,
    });
  } catch (err) {
    console.error("createAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /aset/:id — update ──────────────────────────────────────────────
export const updateAset = async (req, res) => {
  const { id } = req.params;
  const {
    kode_aset, nama_aset, company_id, sub_kategori, brand, model,
    no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan,
    pic_employee_id, kondisi, is_active,
  } = req.body;

  if (!nama_aset?.trim()) return res.status(400).json({ message: "Nama aset wajib diisi" });

  try {
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    // Cek kode duplikat jika diubah
    if (kode_aset) {
      const [dup] = await safeQuery("SELECT id FROM mst_aset WHERE kode_aset = ? AND id != ?", [kode_aset, id]);
      if (dup.length > 0) return res.status(409).json({ message: "Kode aset sudah digunakan" });
    }

    await safeQuery(
      `UPDATE mst_aset SET
        kode_aset=?, nama_aset=?, company_id=?, sub_kategori=?, brand=?, model=?,
        no_seri=?, lokasi_nama=?, lokasi_lat=?, lokasi_lng=?, jumlah=?, satuan=?,
        pic_employee_id=?, kondisi=?, is_active=?, updated_at=NOW()
       WHERE id=?`,
      [
        kode_aset, nama_aset, company_id || null, sub_kategori, brand || null,
        model || null, no_seri || null, lokasi_nama || null,
        lokasi_lat || null, lokasi_lng || null, jumlah || 1,
        satuan || "Unit", pic_employee_id || null, kondisi || "Baik", is_active !== undefined ? (is_active ? 1 : 0) : 1, id,
      ]
    );

    res.json({ message: "Aset berhasil diperbarui" });
  } catch (err) {
    console.error("updateAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /aset/:id — soft delete ──────────────────────────────────────
export const deleteAset = async (req, res) => {
  try {
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [req.params.id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery("UPDATE mst_aset SET is_deleted = 1, updated_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ message: "Aset berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/photos — upload photos ───────────────────────────────
export const uploadPhotos = async (req, res) => {
  const { id } = req.params;

  try {
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "Tidak ada file yang diupload" });
    }

    const captions = req.body.captions || [];
    const values = req.files.map((f, i) => [
      id,
      `aset_photos/${f.filename}`,
      f.originalname,
      Array.isArray(captions) ? captions[i] || null : captions || null,
    ]);

    for (const v of values) {
      await safeQuery(
        "INSERT INTO aset_photos (aset_id, photo_path, photo_name, caption) VALUES (?, ?, ?, ?)",
        v
      );
    }

    const [photos] = await safeQuery(
      "SELECT * FROM aset_photos WHERE aset_id = ? ORDER BY created_at",
      [id]
    );

    res.status(201).json({ message: "Foto berhasil diupload", photos });
  } catch (err) {
    console.error("uploadPhotos error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /aset/photos/:photoId — delete a photo ───────────────────────
export const deletePhoto = async (req, res) => {
  try {
    const [rows] = await safeQuery("SELECT * FROM aset_photos WHERE id = ?", [req.params.photoId]);
    if (rows.length === 0) return res.status(404).json({ message: "Foto tidak ditemukan" });

    const photo = rows[0];

    // Hapus file fisik
    const abs = path.join(BASE_DIR, photo.photo_path);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) {}
    }

    await safeQuery("DELETE FROM aset_photos WHERE id = ?", [req.params.photoId]);
    res.json({ message: "Foto berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};