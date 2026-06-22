import { safeIKMQuery } from "../../db/pool.js";

// ── Reusable helpers ──
const hospitalNotFound = (hospitalId) => `Data linen RS tidak ditemukan`;

// ── GET all hospital_linen for a given hospital ──
export const getByHospital = async (req, res) => {
  const { hospitalId } = req.params;
  try {
    const [rows] = await safeIKMQuery(
      `SELECT hl.id, hl.hospital_id, hl.linen_id, hl.hospital_linen_name,
              hl.ownership_type, hl.unit, hl.grammage,
              hl.washing_price_type, hl.washing_price, hl.rental_price,
              hl.par_stock, hl.min_stock, hl.is_active,
              hl.created_at, hl.updated_at,
              l.linen_code,
              l.linen_name AS master_linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM mst_hospital_linen hl
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE hl.hospital_id = ?
       ORDER BY l.linen_name ASC`,
      [hospitalId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("getByHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET all mst_linen (for dropdown) ──
export const getAllLinen = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM mst_linen l
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       ORDER BY l.linen_name ASC`
    );
    const mapped = rows.map(r => ({
      id: r.id,
      linen_code: r.linen_code,
      linen_name: [r.linen_name, r.size_name, r.color_name, r.material_name].filter(Boolean).join(" "),
    }));
    res.json({ data: mapped });
  } catch (err) {
    console.error("getAllLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── CREATE hospital_linen ──
export const create = async (req, res) => {
  const { hospitalId } = req.params;
  const {
    linen_id, hospital_linen_name, ownership_type, unit, grammage,
    washing_price_type, washing_price, rental_price, par_stock, min_stock, is_active,
  } = req.body;

  if (!linen_id) return res.status(400).json({ message: "Linen wajib dipilih" });

  try {
    const [result] = await safeIKMQuery(
      `INSERT INTO mst_hospital_linen
       (hospital_id, linen_id, hospital_linen_name, ownership_type, unit, grammage,
        washing_price_type, washing_price, rental_price, par_stock, min_stock, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId, linen_id,
        hospital_linen_name?.trim() || null,
        ownership_type || "MILIK_RS",
        unit || "PCS",
        grammage || null,
        washing_price_type || "PCS",
        washing_price ?? 0,
        rental_price ?? 0,
        par_stock ?? 0,
        min_stock ?? 0,
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
      ]
    );
    res.status(201).json({ message: "Linen RS berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("create:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE hospital_linen ──
export const update = async (req, res) => {
  const { hospitalId, id } = req.params;
  const {
    linen_id, hospital_linen_name, ownership_type, unit, grammage,
    washing_price_type, washing_price, rental_price, par_stock, min_stock, is_active,
  } = req.body;

  try {
    const [exist] = await safeIKMQuery(
      `SELECT id FROM mst_hospital_linen WHERE id = ? AND hospital_id = ?`,
      [id, hospitalId]
    );
    if (exist.length === 0) {
      return res.status(404).json({ message: hospitalNotFound(hospitalId) });
    }

    await safeIKMQuery(
      `UPDATE mst_hospital_linen SET
        linen_id = ?, hospital_linen_name = ?, ownership_type = ?, unit = ?,
        grammage = ?, washing_price_type = ?, washing_price = ?, rental_price = ?,
        par_stock = ?, min_stock = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        linen_id ?? exist[0].linen_id,
        hospital_linen_name?.trim() || null,
        ownership_type || "MILIK_RS",
        unit || "PCS",
        grammage || null,
        washing_price_type || "PCS",
        washing_price ?? 0,
        rental_price ?? 0,
        par_stock ?? 0,
        min_stock ?? 0,
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
        id,
      ]
    );
    res.json({ message: "Linen RS berhasil diperbarui" });
  } catch (err) {
    console.error("update:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE hospital_linen ──
export const remove = async (req, res) => {
  const { hospitalId, id } = req.params;
  try {
    await safeIKMQuery(
      `DELETE FROM mst_hospital_linen WHERE id = ? AND hospital_id = ?`,
      [id, hospitalId]
    );
    res.json({ message: "Linen RS berhasil dihapus" });
  } catch (err) {
    console.error("remove:", err);
    res.status(500).json({ message: err.message });
  }
};
