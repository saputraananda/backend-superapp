import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "created_at"];

export const getMaterials = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "name";
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

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_material ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMaterials error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getMaterialById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_material WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Material tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getMaterialById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createMaterial = async (req, res) => {
  try {
    const { code, name, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Material wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "-");
    const trimmedName = name.trim();

    const [existCode] = await safeMyWaschenQuery("SELECT id FROM mst_material WHERE code = ?", [formattedCode]);
    if (existCode.length) {
      return res.status(400).json({ success: false, message: `Kode material "${formattedCode}" sudah digunakan` });
    }

    const [existName] = await safeMyWaschenQuery("SELECT id FROM mst_material WHERE name = ?", [trimmedName]);
    if (existName.length) {
      return res.status(400).json({ success: false, message: `Nama material "${trimmedName}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_material (code, name, description, is_active) VALUES (?, ?, ?, ?)`,
      [
        formattedCode,
        trimmedName,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Material berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createMaterial error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Material wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_material WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Material tidak ditemukan" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "-");
    const trimmedName = name.trim();

    const [dupCode] = await safeMyWaschenQuery(
      "SELECT id FROM mst_material WHERE code = ? AND id != ?",
      [formattedCode, id]
    );
    if (dupCode.length) {
      return res.status(400).json({ success: false, message: `Kode material "${formattedCode}" sudah digunakan` });
    }

    const [dupName] = await safeMyWaschenQuery(
      "SELECT id FROM mst_material WHERE name = ? AND id != ?",
      [trimmedName, id]
    );
    if (dupName.length) {
      return res.status(400).json({ success: false, message: `Nama material "${trimmedName}" sudah digunakan` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_material
       SET code = ?, name = ?, description = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        trimmedName,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Material berhasil diperbarui" });
  } catch (err) {
    console.error("updateMaterial error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteMaterial = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_material WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Material tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction_detail WHERE material = (SELECT name FROM mst_material WHERE id = ?) LIMIT 1",
      [id]
    );
    if (used.length) {
      return res.status(400).json({
        success: false,
        message: "Material tidak dapat dihapus karena sudah digunakan pada detail transaksi",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_material WHERE id = ?", [id]);
    res.json({ success: true, message: "Material berhasil dihapus" });
  } catch (err) {
    console.error("deleteMaterial error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
