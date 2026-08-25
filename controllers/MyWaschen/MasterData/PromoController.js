import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "discount_type", "sort_order", "created_at"];
const DISCOUNT_TYPES = ["none", "percentage", "nominal"];

export const getPromos = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const discountType = req.query.discountType;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "sort_order";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    if (discountType && DISCOUNT_TYPES.includes(discountType)) {
      where.push("discount_type = ?");
      params.push(discountType);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_promo ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getPromos error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPromoById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_promo WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getPromoById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPromo = async (req, res) => {
  try {
    const { code, name, discount_type, discount_value, description, sort_order, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama promo wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const discType = DISCOUNT_TYPES.includes(discount_type) ? discount_type : "none";

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_promo (code, name, discount_type, discount_value, description, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        discType,
        discount_value !== undefined ? Number(discount_value) : 0,
        description?.trim() || null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Promo berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createPromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePromo = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, discount_type, discount_value, description, sort_order, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama promo wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    const discType = DISCOUNT_TYPES.includes(discount_type) ? discount_type : "none";

    await safeMyWaschenQuery(
      `UPDATE mst_promo
       SET code = COALESCE(?, code),
           name = ?,
           discount_type = ?,
           discount_value = ?,
           description = ?,
           sort_order = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        discType,
        discount_value !== undefined ? Number(discount_value) : 0,
        description?.trim() || null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Promo berhasil diperbarui" });
  } catch (err) {
    console.error("updatePromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deletePromo = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_promo WHERE id = ?", [id]);
    res.json({ success: true, message: "Promo berhasil dihapus" });
  } catch (err) {
    console.error("deletePromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
