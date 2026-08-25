import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "label", "sort_order", "created_at"];

export const getPaymentMethods = async (req, res) => {
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
      `SELECT * FROM mst_payment_method ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getPaymentMethods error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPaymentMethodById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_payment_method WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getPaymentMethodById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPaymentMethod = async (req, res) => {
  try {
    const { code, name, label, requires_member_balance, sort_order, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_payment_method WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_payment_method (code, name, label, requires_member_balance, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        requires_member_balance ? 1 : 0,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Metode pembayaran berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createPaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, label, requires_member_balance, sort_order, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_payment_method WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_payment_method WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_payment_method
       SET code = COALESCE(?, code),
           name = ?,
           label = ?,
           requires_member_balance = ?,
           sort_order = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        requires_member_balance ? 1 : 0,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Metode pembayaran berhasil diperbarui" });
  } catch (err) {
    console.error("updatePaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id, code FROM mst_payment_method WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_payment_method WHERE id = ?", [id]);
    res.json({ success: true, message: "Metode pembayaran berhasil dihapus" });
  } catch (err) {
    console.error("deletePaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
