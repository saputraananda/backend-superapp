import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/promos -> Get all promos
export const getPromos = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT p.*, u.name as creator_name
       FROM mst_promo p
       LEFT JOIN mst_user u ON p.created_by = u.id
       WHERE p.deleted_at IS NULL
       ORDER BY p.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getPromos] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/promos -> Create promo
export const createPromo = async (req, res) => {
  try {
    const { code, name, type, value, min_trx_amount, max_discount, valid_from, valid_until, is_global } = req.body;
    const userId = req.session.userId || 1;

    if (!code || !name || !type || value === undefined || !valid_from || !valid_until) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_promo WHERE code = ? AND deleted_at IS NULL",
      [code]
    );
    if (dup.length > 0) {
      return res.status(400).json({ success: false, message: `Promo with code ${code} already exists.` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_promo (
        code, name, type, value, min_trx_amount, max_discount, 
        valid_from, valid_until, is_global, is_active, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        code, name, type, value, min_trx_amount || null, max_discount || null,
        valid_from, valid_until, is_global || 0, userId
      ]
    );

    return res.json({ success: true, message: "Promo created successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[createPromo] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/promos/:id -> Update promo
export const updatePromo = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, type, value, min_trx_amount, max_discount, valid_from, valid_until, is_global, is_active } = req.body;

    const [existing] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Promo not found." });
    }

    if (code) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_promo WHERE code = ? AND id != ? AND deleted_at IS NULL",
        [code, id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: `Promo with code ${code} already exists.` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_promo 
       SET code = COALESCE(?, code),
           name = COALESCE(?, name),
           type = COALESCE(?, type),
           value = COALESCE(?, value),
           min_trx_amount = ?,
           max_discount = ?,
           valid_from = COALESCE(?, valid_from),
           valid_until = COALESCE(?, valid_until),
           is_global = COALESCE(?, is_global),
           is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        code, name, type, value, min_trx_amount, max_discount,
        valid_from, valid_until, is_global, is_active, id
      ]
    );

    return res.json({ success: true, message: "Promo updated successfully" });
  } catch (err) {
    console.error("[updatePromo] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/promos/:id -> Soft delete promo
export const deletePromo = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.session.userId || 1;

    await safeMyWaschenQuery(
      "UPDATE mst_promo SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?",
      [adminId, id]
    );
    return res.json({ success: true, message: "Promo soft-deleted successfully" });
  } catch (err) {
    console.error("[deletePromo] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
