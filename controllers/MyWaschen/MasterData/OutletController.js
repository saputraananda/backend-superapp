import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "outlet_code", "name", "full_name", "created_at"];

export const getOutlets = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "id";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(outlet_code LIKE ? OR name LIKE ? OR full_name LIKE ? OR address LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_outlet ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getOutlets error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getOutletById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_outlet WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getOutletById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createOutlet = async (req, res) => {
  try {
    const { outlet_code, name, full_name, address } = req.body;

    if (!outlet_code?.trim() || !name?.trim() || !full_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Kode Outlet, Nama, dan Nama Lengkap wajib diisi",
      });
    }

    const formattedCode = outlet_code.trim().toUpperCase();

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE outlet_code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode outlet "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_outlet (outlet_code, name, full_name, address) VALUES (?, ?, ?, ?)`,
      [formattedCode, name.trim(), full_name.trim(), address?.trim() || null]
    );

    res.status(201).json({ success: true, message: "Outlet berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createOutlet error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateOutlet = async (req, res) => {
  try {
    const { id } = req.params;
    const { outlet_code, name, full_name, address } = req.body;

    if (!outlet_code?.trim() || !name?.trim() || !full_name?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Kode Outlet, Nama, dan Nama Lengkap wajib diisi",
      });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }

    const formattedCode = outlet_code.trim().toUpperCase();

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_outlet WHERE outlet_code = ? AND id != ?",
      [formattedCode, id]
    );
    if (dup.length) {
      return res.status(400).json({ success: false, message: `Kode outlet "${formattedCode}" sudah digunakan` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_outlet
       SET outlet_code = ?, name = ?, full_name = ?, address = ?, updated_at = NOW()
       WHERE id = ?`,
      [formattedCode, name.trim(), full_name.trim(), address?.trim() || null, id]
    );

    res.json({ success: true, message: "Outlet berhasil diperbarui" });
  } catch (err) {
    console.error("updateOutlet error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteOutlet = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }

    const [usedCustomer] = await safeMyWaschenQuery(
      "SELECT id FROM mst_customer WHERE preferred_outlet_id = ? LIMIT 1",
      [id]
    );
    if (usedCustomer.length) {
      return res.status(400).json({
        success: false,
        message: "Outlet tidak dapat dihapus karena masih dipakai pelanggan",
      });
    }

    const [usedTxn] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction WHERE outlet_id = ? LIMIT 1",
      [id]
    );
    if (usedTxn.length) {
      return res.status(400).json({
        success: false,
        message: "Outlet tidak dapat dihapus karena sudah memiliki transaksi",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_outlet WHERE id = ?", [id]);
    res.json({ success: true, message: "Outlet berhasil dihapus" });
  } catch (err) {
    console.error("deleteOutlet error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
