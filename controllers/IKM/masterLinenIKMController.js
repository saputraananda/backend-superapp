// src/controllers/IKM/masterLinenIKMController.js
import { safeIKMQuery } from "../../db/pool.js";

const TABLE = "mst_linen";

// ── GET list with pagination, search, category filter, include size/color/material ──
export const getLinenList = async (req, res) => {
  try {
    const { page = 1, limit = 25, search = "", category_id = "" } = req.query;
    const pg = Math.max(1, Number(page) || 1);
    const lm = Math.max(1, Number(limit) || 25);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (search.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(l.linen_code LIKE ? OR l.linen_name LIKE ? OR l.description LIKE ? OR c.category_name LIKE ?)");
      params.push(like, like, like, like);
    }

    if (category_id) {
      where.push("l.category_id = ?");
      params.push(category_id);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total FROM ${TABLE} l LEFT JOIN mst_linen_category c ON l.category_id = c.id ${whereSql}`, params
    );

    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name,
              l.category_id, c.category_code, c.category_name,
              l.size_id, sz.size_code, sz.size_name,
              l.color_id, cl.color_code, cl.color_name,
              l.material_id, mt.material_code, mt.material_name,
              l.default_qty, l.description,
              l.created_at, l.updated_at
       FROM ${TABLE} l
       LEFT JOIN mst_linen_category c ON l.category_id = c.id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       ${whereSql}
       ORDER BY l.linen_code ASC LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    res.json({
      data: rows,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) || 1 },
    });
  } catch (err) {
    console.error("getLinenList:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET single linen by ID (with all joins) ──
export const getLinenById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name,
              l.category_id, c.category_code, c.category_name,
              l.size_id, sz.size_code, sz.size_name,
              l.color_id, cl.color_code, cl.color_name,
              l.material_id, mt.material_code, mt.material_name,
              l.default_qty, l.description,
              l.created_at, l.updated_at
       FROM ${TABLE} l
       LEFT JOIN mst_linen_category c ON l.category_id = c.id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE l.id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Linen tidak ditemukan" });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error("getLinenById:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET all mst_linen for dropdown (lightweight) ──
export const getLinenDropdown = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM ${TABLE} l
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
    console.error("getLinenDropdown:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET categories ──
export const getCategories = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT id, category_code, category_name, description, sort_order FROM mst_linen_category ORDER BY sort_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("getCategories:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET sizes ──
export const getSizes = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(`SELECT id, size_code, size_name FROM mst_size ORDER BY sort_order ASC`);
    res.json(rows);
  } catch (err) {
    console.error("getSizes:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET colors ──
export const getColors = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(`SELECT id, color_code, color_name FROM mst_color ORDER BY sort_order ASC`);
    res.json(rows);
  } catch (err) {
    console.error("getColors:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET materials ──
export const getMaterials = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(`SELECT id, material_code, material_name FROM mst_material ORDER BY material_name ASC`);
    res.json(rows);
  } catch (err) {
    console.error("getMaterials:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── CREATE linen ──
export const createLinen = async (req, res) => {
  try {
    const { linen_code, linen_name, category_id, size_id, color_id, material_id, default_qty, description } = req.body;

    if (!linen_name?.trim()) {
      return res.status(400).json({ message: "Nama linen wajib diisi" });
    }

    if (linen_code?.trim()) {
      const [dupCode] = await safeIKMQuery(
        `SELECT id FROM ${TABLE} WHERE linen_code = ?`, [linen_code.trim()]
      );
      if (dupCode.length > 0) {
        return res.status(409).json({ message: "Kode linen sudah ada" });
      }
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO ${TABLE} (linen_code, linen_name, category_id, size_id, color_id, material_id, default_qty, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        linen_code?.trim() || null,
        linen_name.trim(),
        category_id || null,
        size_id || null,
        color_id || null,
        material_id || null,
        default_qty ?? 0,
        description?.trim() || null,
      ]
    );

    res.status(201).json({ message: "Linen berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE linen ──
export const updateLinen = async (req, res) => {
  try {
    const { id } = req.params;
    const { linen_code, linen_name, category_id, size_id, color_id, material_id, default_qty, description } = req.body;

    if (!linen_name?.trim()) {
      return res.status(400).json({ message: "Nama linen wajib diisi" });
    }

    const [exist] = await safeIKMQuery(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (exist.length === 0) {
      return res.status(404).json({ message: "Linen tidak ditemukan" });
    }

    if (linen_code?.trim()) {
      const [dupCode] = await safeIKMQuery(
        `SELECT id FROM ${TABLE} WHERE linen_code = ? AND id != ?`,
        [linen_code.trim(), id]
      );
      if (dupCode.length > 0) {
        return res.status(409).json({ message: "Kode linen sudah digunakan" });
      }
    }

    await safeIKMQuery(
      `UPDATE ${TABLE} SET linen_code = ?, linen_name = ?, category_id = ?,
       size_id = ?, color_id = ?, material_id = ?, default_qty = ?, description = ?
       WHERE id = ?`,
      [
        linen_code?.trim() || null,
        linen_name.trim(),
        category_id || null,
        size_id || null,
        color_id || null,
        material_id || null,
        default_qty ?? 0,
        description?.trim() || null,
        id,
      ]
    );

    res.json({ message: "Linen berhasil diperbarui" });
  } catch (err) {
    console.error("updateLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE linen ──
export const deleteLinen = async (req, res) => {
  try {
    const { id } = req.params;

    const [exist] = await safeIKMQuery(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (exist.length === 0) {
      return res.status(404).json({ message: "Linen tidak ditemukan" });
    }

    const [used] = await safeIKMQuery(
      `SELECT COUNT(*) AS cnt FROM mst_hospital_linen WHERE linen_id = ?`, [id]
    );
    if (used[0]?.cnt > 0) {
      return res.status(409).json({
        message: `Linen masih digunakan oleh ${used[0].cnt} rumah sakit. Tidak bisa dihapus.`
      });
    }

    await safeIKMQuery(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    res.json({ message: "Linen berhasil dihapus" });
  } catch (err) {
    console.error("deleteLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

// ════════════════════════════════════════════════════════════════
// RIWAYAT HARGA BELI
// ════════════════════════════════════════════════════════════════

// ── GET price history for a linen ──
export const getPriceHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeIKMQuery(
      `SELECT id, linen_id, purchase_price, effective_date, notes, created_by, created_at
       FROM tr_linen_purchase_price
       WHERE linen_id = ?
       ORDER BY effective_date DESC, created_at DESC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("getPriceHistory:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── ADD price history entry ──
export const addPriceHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { purchase_price, effective_date, notes } = req.body;

    if (purchase_price === undefined || purchase_price === null) {
      return res.status(400).json({ message: "Harga beli wajib diisi" });
    }
    if (!effective_date) {
      return res.status(400).json({ message: "Tanggal efektif wajib diisi" });
    }

    // Verify linen exists
    const [exist] = await safeIKMQuery(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (exist.length === 0) {
      return res.status(404).json({ message: "Linen tidak ditemukan" });
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO tr_linen_purchase_price (linen_id, purchase_price, effective_date, notes, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [id, purchase_price, effective_date, notes?.trim() || null, req.user?.username || null]
    );

    res.status(201).json({ message: "Harga beli berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("addPriceHistory:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE price history entry ──
export const deletePriceHistory = async (req, res) => {
  try {
    const { priceId } = req.params;
    await safeIKMQuery(`DELETE FROM tr_linen_purchase_price WHERE id = ?`, [priceId]);
    res.json({ message: "Riwayat harga berhasil dihapus" });
  } catch (err) {
    console.error("deletePriceHistory:", err);
    res.status(500).json({ message: err.message });
  }
};
