import { safeMyWaschenQuery } from "../../../db/pool.js";

// ── 1. GET LIST ──
export const getUnits = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const categoryType = req.query.categoryType;
    const sortBy = ["code", "name", "symbol", "category_type", "created_at"].includes(req.query.sortBy)
      ? req.query.sortBy
      : "id";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR symbol LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    if (categoryType) {
      where.push("category_type = ?");
      params.push(categoryType);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_unit ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getUnits error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2. GET BY ID ──
export const getUnitById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_unit WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Satuan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getUnitById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 3. CREATE ──
export const createUnit = async (req, res) => {
  try {
    const { code, name, symbol, category_type, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !symbol?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Simbol Satuan wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase();

    // Check duplicate code
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_unit WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode satuan "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_unit (code, name, symbol, category_type, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        symbol.trim(),
        ["Kiloan", "Satuan"].includes(category_type) ? category_type : "Satuan",
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1
      ]
    );

    res.status(201).json({
      success: true,
      message: "Satuan berhasil ditambahkan",
      id: result.insertId
    });
  } catch (err) {
    console.error("createUnit error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 4. UPDATE ──
export const updateUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, symbol, category_type, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !symbol?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Simbol Satuan wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_unit WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Satuan tidak ditemukan" });
    }

    const formattedCode = code.trim().toUpperCase();

    const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_unit WHERE code = ? AND id != ?", [formattedCode, id]);
    if (dup.length) {
      return res.status(400).json({ success: false, message: `Kode satuan "${formattedCode}" sudah digunakan` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_unit
       SET code = ?,
           name = ?,
           symbol = ?,
           category_type = ?,
           description = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        symbol.trim(),
        ["Kiloan", "Satuan"].includes(category_type) ? category_type : "Satuan",
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id
      ]
    );

    res.json({ success: true, message: "Satuan berhasil diperbarui" });
  } catch (err) {
    console.error("updateUnit error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 5. DELETE ──
export const deleteUnit = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_unit WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Satuan tidak ditemukan" });
    }

    const [usedInService] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE unit_id = ? LIMIT 1", [id]);
    if (usedInService.length) {
      return res.status(400).json({
        success: false,
        message: "Satuan ini tidak dapat dihapus karena sedang digunakan oleh beberapa Layanan Laundry."
      });
    }

    const [usedInInventory] = await safeMyWaschenQuery(
      "SELECT id FROM mst_inventory_item WHERE unit_id = ? LIMIT 1",
      [id]
    );
    if (usedInInventory.length) {
      return res.status(400).json({
        success: false,
        message: "Satuan ini tidak dapat dihapus karena sedang digunakan oleh item Inventory."
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_unit WHERE id = ?", [id]);
    res.json({ success: true, message: "Satuan berhasil dihapus" });
  } catch (err) {
    console.error("deleteUnit error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
