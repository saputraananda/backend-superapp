import { safeMyWaschenQuery } from "../../../db/pool.js";

// ── 1. GET LIST ──
export const getServiceSpeeds = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = ["code", "name", "duration_hours", "duration_multiplier", "price_multiplier", "created_at"].includes(req.query.sortBy)
      ? req.query.sortBy
      : "id";
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
      `SELECT * FROM mst_service_speed ${whereSql} ORDER BY ${sortBy} ${sortDir}, id ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getServiceSpeeds error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2. GET BY ID ──
export const getServiceSpeedById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_service_speed WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Kecepatan layanan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getServiceSpeedById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 3. CREATE ──
export const createServiceSpeed = async (req, res) => {
  try {
    const { name, code, duration_hours, duration_multiplier, price_multiplier, additional_fee, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Kecepatan Layanan wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase();

    // Check duplicate code
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_speed WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode kecepatan "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_service_speed (name, code, duration_hours, duration_multiplier, price_multiplier, additional_fee, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        formattedCode,
        duration_hours !== undefined && duration_hours !== "" ? Number(duration_hours) : 48,
        Number(duration_multiplier) || 1.0,
        Number(price_multiplier) || 1.0,
        Number(additional_fee) || 0.0,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1
      ]
    );

    res.status(201).json({
      success: true,
      message: "Kecepatan layanan berhasil ditambahkan",
      id: result.insertId
    });
  } catch (err) {
    console.error("createServiceSpeed error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 4. UPDATE ──
export const updateServiceSpeed = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, duration_hours, duration_multiplier, price_multiplier, additional_fee, description, is_active } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Kecepatan Layanan wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_speed WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kecepatan layanan tidak ditemukan" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase() : null;

    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_service_speed WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode kecepatan "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_service_speed
       SET name = ?,
           code = COALESCE(?, code),
           duration_hours = ?,
           duration_multiplier = ?,
           price_multiplier = ?,
           additional_fee = ?,
           description = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        name.trim(),
        formattedCode,
        duration_hours !== undefined && duration_hours !== "" ? Number(duration_hours) : 48,
        Number(duration_multiplier) || 1.0,
        Number(price_multiplier) || 1.0,
        Number(additional_fee) || 0.0,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id
      ]
    );

    res.json({ success: true, message: "Kecepatan layanan berhasil diperbarui" });
  } catch (err) {
    console.error("updateServiceSpeed error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 5. DELETE ──
export const deleteServiceSpeed = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_speed WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kecepatan layanan tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_service_speed WHERE id = ?", [id]);
    res.json({ success: true, message: "Kecepatan layanan berhasil dihapus" });
  } catch (err) {
    console.error("deleteServiceSpeed error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
