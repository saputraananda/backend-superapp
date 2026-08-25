import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "sort_order", "min_monthly_spending", "created_at"];

export const getCustomerTiers = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "sort_order";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR label LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_customer_tier ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getCustomerTiers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getCustomerTierById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_customer_tier WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Tier pelanggan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getCustomerTierById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createCustomerTier = async (req, res) => {
  try {
    const {
      code, name, label, min_monthly_spending, max_monthly_spending,
      min_total_orders, max_total_orders, sort_order, is_active,
    } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_tier WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_customer_tier
        (code, name, label, min_monthly_spending, max_monthly_spending, min_total_orders, max_total_orders, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        min_monthly_spending != null && min_monthly_spending !== "" ? Number(min_monthly_spending) : null,
        max_monthly_spending != null && max_monthly_spending !== "" ? Number(max_monthly_spending) : null,
        min_total_orders != null && min_total_orders !== "" ? Number(min_total_orders) : null,
        max_total_orders != null && max_total_orders !== "" ? Number(max_total_orders) : null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Tier pelanggan berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createCustomerTier error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateCustomerTier = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      code, name, label, min_monthly_spending, max_monthly_spending,
      min_total_orders, max_total_orders, sort_order, is_active,
    } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_tier WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Tier pelanggan tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_customer_tier WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_customer_tier SET
        code = COALESCE(?, code),
        name = ?,
        label = ?,
        min_monthly_spending = ?,
        max_monthly_spending = ?,
        min_total_orders = ?,
        max_total_orders = ?,
        sort_order = ?,
        is_active = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        min_monthly_spending != null && min_monthly_spending !== "" ? Number(min_monthly_spending) : null,
        max_monthly_spending != null && max_monthly_spending !== "" ? Number(max_monthly_spending) : null,
        min_total_orders != null && min_total_orders !== "" ? Number(min_total_orders) : null,
        max_total_orders != null && max_total_orders !== "" ? Number(max_total_orders) : null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Tier pelanggan berhasil diperbarui" });
  } catch (err) {
    console.error("updateCustomerTier error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteCustomerTier = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_tier WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Tier pelanggan tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery("SELECT id FROM mst_customer WHERE spending_tier_id = ? LIMIT 1", [id]);
    if (used.length) {
      return res.status(400).json({ success: false, message: "Tier tidak dapat dihapus karena masih digunakan pelanggan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_customer_tier WHERE id = ?", [id]);
    res.json({ success: true, message: "Tier pelanggan berhasil dihapus" });
  } catch (err) {
    console.error("deleteCustomerTier error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
