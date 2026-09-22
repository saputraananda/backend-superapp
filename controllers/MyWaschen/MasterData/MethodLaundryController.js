import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "created_at"];

export const getMethodLaundries = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "id";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_method_laundry ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMethodLaundries error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getMethodLaundryById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_method_laundry WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Metode laundry tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getMethodLaundryById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createMethodLaundry = async (req, res) => {
  try {
    const { code, name, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Metode wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_method_laundry WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode metode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_method_laundry (code, name, is_active) VALUES (?, ?, ?)`,
      [formattedCode, name.trim(), is_active !== undefined ? Number(is_active) : 1]
    );

    res.status(201).json({ success: true, message: "Metode laundry berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createMethodLaundry error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateMethodLaundry = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Metode wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_method_laundry WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode laundry tidak ditemukan" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_method_laundry WHERE code = ? AND id != ?",
      [formattedCode, id]
    );
    if (dup.length) {
      return res.status(400).json({ success: false, message: `Kode metode "${formattedCode}" sudah digunakan` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_method_laundry
       SET code = ?, name = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [formattedCode, name.trim(), is_active !== undefined ? Number(is_active) : 1, id]
    );

    res.json({ success: true, message: "Metode laundry berhasil diperbarui" });
  } catch (err) {
    console.error("updateMethodLaundry error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteMethodLaundry = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_method_laundry WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode laundry tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction_detail WHERE laundry_method_id = ? LIMIT 1",
      [id]
    );
    if (used.length) {
      return res.status(400).json({
        success: false,
        message: "Metode tidak dapat dihapus karena sudah digunakan pada detail transaksi",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_method_laundry WHERE id = ?", [id]);
    res.json({ success: true, message: "Metode laundry berhasil dihapus" });
  } catch (err) {
    console.error("deleteMethodLaundry error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
