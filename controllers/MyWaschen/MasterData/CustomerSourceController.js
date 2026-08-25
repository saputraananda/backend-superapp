import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "label", "created_at"];

export const getCustomerSources = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "name";
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
      `SELECT * FROM mst_customer_source ${whereSql} ORDER BY ${sortBy} ${sortDir}, id ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getCustomerSources error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getCustomerSourceById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_customer_source WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Sumber pelanggan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getCustomerSourceById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createCustomerSource = async (req, res) => {
  try {
    const { code, name, label, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_source WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_customer_source (code, name, label, is_active)
       VALUES (?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Sumber pelanggan berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createCustomerSource error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateCustomerSource = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, label, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_source WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Sumber pelanggan tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_customer_source WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_customer_source SET
        code = COALESCE(?, code),
        name = ?,
        label = ?,
        is_active = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Sumber pelanggan berhasil diperbarui" });
  } catch (err) {
    console.error("updateCustomerSource error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteCustomerSource = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer_source WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Sumber pelanggan tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery("SELECT id FROM mst_customer WHERE customer_source_id = ? LIMIT 1", [id]);
    if (used.length) {
      return res.status(400).json({ success: false, message: "Sumber tidak dapat dihapus karena masih digunakan pelanggan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_customer_source WHERE id = ?", [id]);
    res.json({ success: true, message: "Sumber pelanggan berhasil dihapus" });
  } catch (err) {
    console.error("deleteCustomerSource error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
