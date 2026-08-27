import { safeMyWaschenQuery } from "../../../db/pool.js";

// ── Helper: Generate kode otomatis (WS-KG-### untuk Kiloan, WS-SAT-### untuk Satuan) ──
export const generateNextServiceCode = async (categoryId) => {
  const prefix = Number(categoryId) === 1 ? "WS-KG-" : "WS-SAT-";
  const [rows] = await safeMyWaschenQuery(
    `SELECT code FROM mst_service WHERE code LIKE ? ORDER BY code DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let nextNum = 1;
  if (rows.length) {
    const numPart = String(rows[0].code).split("-").pop();
    nextNum = (parseInt(numPart, 10) || 0) + 1;
  }
  return `${prefix}${String(nextNum).padStart(3, "0")}`;
};

// ── 1. GET LIST ──
export const getServices = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const unitId = req.query.unitId ? Number(req.query.unitId) : null;
    const isActive = req.query.isActive;
    const isFeatured = req.query.isFeatured;
    const sortBy = ["code", "name", "price", "category_id", "regular_duration_days", "created_at"].includes(req.query.sortBy)
      ? req.query.sortBy
      : "s.name";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(s.code LIKE ? OR s.name LIKE ? OR s.description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (categoryId) {
      where.push("s.category_id = ?");
      params.push(categoryId);
    }

    if (unitId) {
      where.push("s.unit_id = ?");
      params.push(unitId);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("s.is_active = ?");
      params.push(Number(isActive));
    }

    if (isFeatured !== undefined && isFeatured !== "") {
      where.push("s.is_featured = ?");
      params.push(Number(isFeatured));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, c.name AS category_name, c.code AS category_code,
              u.name AS unit_name_full, u.symbol AS unit_symbol, u.code AS unit_code
       FROM mst_service s
       LEFT JOIN mst_service_category c ON s.category_id = c.id
       LEFT JOIN mst_unit u ON s.unit_id = u.id
       ${whereSql}
       ORDER BY ${sortBy} ${sortDir}`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getServices error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2. GET BY ID ──
export const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, c.name AS category_name, c.code AS category_code,
              u.name AS unit_name_full, u.symbol AS unit_symbol, u.code AS unit_code
       FROM mst_service s
       LEFT JOIN mst_service_category c ON s.category_id = c.id
       LEFT JOIN mst_unit u ON s.unit_id = u.id
       WHERE s.id = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getServiceById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2b. GET NEXT CODE (kode otomatis berdasarkan kategori) ──
export const getNextServiceCode = async (req, res) => {
  try {
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    if (!categoryId) {
      return res.status(400).json({ success: false, message: "categoryId wajib diisi" });
    }
    const code = await generateNextServiceCode(categoryId);
    res.json({ success: true, data: { code } });
  } catch (err) {
    console.error("getNextServiceCode error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 3. CREATE ──
export const createService = async (req, res) => {
  try {
    const { category_id, unit_id, code, name, unit, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active } = req.body;

    if (!category_id || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kategori dan Nama Layanan wajib diisi" });
    }

    // Kode otomatis bila tidak diisi: WS-KG-### (Kiloan) / WS-SAT-### (Satuan)
    const formattedCode = code?.trim()
      ? code.trim().toUpperCase()
      : await generateNextServiceCode(category_id);

    // Check duplicate code
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode layanan "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_service (category_id, unit_id, unit, code, name, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(category_id),
        unit_id ? Number(unit_id) : 1,
        unit?.trim() || "Kg",
        formattedCode,
        name.trim(),
        Number(price) || 0,
        Number(regular_duration_days) || 2.0,
        Number(min_order_qty) || 1.0,
        description?.trim() || null,
        is_cleanox !== undefined ? Number(is_cleanox) : 0,
        is_featured !== undefined ? Number(is_featured) : 0,
        is_active !== undefined ? Number(is_active) : 1
      ]
    );

    res.status(201).json({
      success: true,
      message: "Layanan berhasil ditambahkan",
      id: result.insertId,
      code: formattedCode
    });
  } catch (err) {
    console.error("createService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 4. UPDATE ──
export const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, unit_id, code, name, unit, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Layanan wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase() : null;

    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode layanan "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_service
       SET category_id = COALESCE(?, category_id),
           unit_id = ?,
           unit = ?,
           code = COALESCE(?, code),
           name = ?,
           price = ?,
           regular_duration_days = ?,
           min_order_qty = ?,
           description = ?,
           is_cleanox = ?,
           is_featured = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        category_id ? Number(category_id) : null,
        unit_id ? Number(unit_id) : 1,
        unit?.trim() || "Kg",
        formattedCode,
        name.trim(),
        Number(price) || 0,
        Number(regular_duration_days) || 2.0,
        Number(min_order_qty) || 1.0,
        description?.trim() || null,
        is_cleanox !== undefined ? Number(is_cleanox) : 0,
        is_featured !== undefined ? Number(is_featured) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id
      ]
    );

    res.json({ success: true, message: "Layanan berhasil diperbarui" });
  } catch (err) {
    console.error("updateService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 5. DELETE ──
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_service WHERE id = ?", [id]);
    res.json({ success: true, message: "Layanan berhasil dihapus" });
  } catch (err) {
    console.error("deleteService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
