import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "label", "flow_type", "created_at"];
const FLOW_TYPES = ["Masuk", "Keluar", "Both"];

export const getPettyCashCategories = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const flowType = req.query.flowType;
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

    if (flowType && FLOW_TYPES.includes(flowType)) {
      where.push("flow_type = ?");
      params.push(flowType);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_petty_cash_category ${whereSql} ORDER BY ${sortBy} ${sortDir}, id ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getPettyCashCategories error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPettyCashCategoryById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_petty_cash_category WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Kategori petty cash tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getPettyCashCategoryById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPettyCashCategory = async (req, res) => {
  try {
    const { code, name, label, flow_type, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const flowType = FLOW_TYPES.includes(flow_type) ? flow_type : "Keluar";

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_petty_cash_category WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_petty_cash_category (code, name, label, flow_type, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        flowType,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Kategori petty cash berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createPettyCashCategory error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePettyCashCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, label, flow_type, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_petty_cash_category WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kategori petty cash tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_petty_cash_category WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    const flowType = FLOW_TYPES.includes(flow_type) ? flow_type : "Keluar";

    await safeMyWaschenQuery(
      `UPDATE mst_petty_cash_category
       SET code = COALESCE(?, code),
           name = ?,
           label = ?,
           flow_type = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        flowType,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Kategori petty cash berhasil diperbarui" });
  } catch (err) {
    console.error("updatePettyCashCategory error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deletePettyCashCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_petty_cash_category WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kategori petty cash tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_petty_cash_category WHERE id = ?", [id]);
    res.json({ success: true, message: "Kategori petty cash berhasil dihapus" });
  } catch (err) {
    console.error("deletePettyCashCategory error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
