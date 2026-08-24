import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "label", "percentage", "created_at"];

function normalizePercentage(value) {
  if (value === undefined || value === null || value === "") return 10;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

export const getStatusWorks = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const isFilterTab = req.query.isFilterTab;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "percentage";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR label LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    if (isFilterTab !== undefined && isFilterTab !== "") {
      where.push("is_filter_tab = ?");
      params.push(Number(isFilterTab));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_work_status ${whereSql} ORDER BY ${sortBy} ${sortDir}, id ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getStatusWorks error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getStatusWorkById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_work_status WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Status pekerjaan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getStatusWorkById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createStatusWork = async (req, res) => {
  try {
    const { code, name, label, description, percentage, is_filter_tab, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const pct = normalizePercentage(percentage);
    if (pct === null || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, message: "Percentage harus antara 0 dan 100" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_work_status WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_work_status (code, name, label, description, percentage, is_filter_tab, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        description?.trim() || null,
        pct,
        is_filter_tab !== undefined ? Number(is_filter_tab) : 1,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Status pekerjaan berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createStatusWork error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateStatusWork = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, label, description, percentage, is_filter_tab, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_work_status WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Status pekerjaan tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const pct = normalizePercentage(percentage);
    if (pct === null || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, message: "Percentage harus antara 0 dan 100" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_work_status WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_work_status
       SET code = COALESCE(?, code),
           name = ?,
           label = ?,
           description = ?,
           percentage = ?,
           is_filter_tab = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        description?.trim() || null,
        pct,
        is_filter_tab !== undefined ? Number(is_filter_tab) : 1,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Status pekerjaan berhasil diperbarui" });
  } catch (err) {
    console.error("updateStatusWork error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteStatusWork = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_work_status WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Status pekerjaan tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_work_status WHERE id = ?", [id]);
    res.json({ success: true, message: "Status pekerjaan berhasil dihapus" });
  } catch (err) {
    console.error("deleteStatusWork error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
