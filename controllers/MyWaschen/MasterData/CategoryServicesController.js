import { safeMyWaschenQuery } from "../../../db/pool.js";

async function ensureTable() {
  try {
    await safeMyWaschenQuery(`
      CREATE TABLE IF NOT EXISTS \`mst_service_category\` (
        \`id\` int unsigned NOT NULL AUTO_INCREMENT,
        \`code\` varchar(50) NOT NULL,
        \`name\` varchar(100) NOT NULL,
        \`icon\` varchar(100) DEFAULT NULL,
        \`description\` text,
        \`is_active\` tinyint(1) NOT NULL DEFAULT '1',
        \`created_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uq_category_code\` (\`code\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Seed default categories if table is empty
    const [rows] = await safeMyWaschenQuery("SELECT COUNT(*) as cnt FROM mst_service_category");
    if (rows[0].cnt === 0) {
      await safeMyWaschenQuery(`
        INSERT INTO mst_service_category (code, name, icon, description, is_active) VALUES
        ('KILOAN', 'Layanan Kiloan', 'Scale', 'Pencucian pakaian harian dengan hitungan per kilogram', 1),
        ('SATUAN', 'Layanan Satuan', 'Shirt', 'Penanganan khusus per pcs pakaian premium, jas, dress & gaun', 1),
        ('SEPATU_TAS', 'Sepatu & Tas', 'Sparkles', 'Perawatan & deep cleaning sepatu, tas & dompet kulit', 1),
        ('BEDDING_KARPET', 'Bedding & Karpet', 'Home', 'Pencucian selimut, bedcover, sprei, tirai & karpet', 1)
      `);
    }
  } catch (err) {
    console.error("ensureTable mst_service_category error:", err);
  }
}

// Ensure table on module load
ensureTable();

// ── 1. GET LIST ──
export const getCategoryServices = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = ["code", "name", "id", "created_at"].includes(req.query.sortBy)
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
      `SELECT * FROM mst_service_category ${whereSql} ORDER BY ${sortBy} ${sortDir}`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getCategoryServices error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2. GET BY ID ──
export const getCategoryServiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_service_category WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Kategori layanan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getCategoryServiceById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 3. CREATE ──
export const createCategoryService = async (req, res) => {
  try {
    const { code, name, icon, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama Kategori wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    // Check duplicate code
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_category WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode kategori "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_service_category (code, name, icon, description, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        icon?.trim() || null,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1
      ]
    );

    res.status(201).json({
      success: true,
      message: "Kategori layanan berhasil ditambahkan",
      id: result.insertId
    });
  } catch (err) {
    console.error("createCategoryService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 4. UPDATE ──
export const updateCategoryService = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, icon, description, is_active } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Kategori wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_category WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kategori layanan tidak ditemukan" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;

    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_service_category WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode kategori "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_service_category
       SET code = COALESCE(?, code),
           name = ?,
           icon = ?,
           description = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        icon?.trim() || null,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id
      ]
    );

    res.json({ success: true, message: "Kategori layanan berhasil diperbarui" });
  } catch (err) {
    console.error("updateCategoryService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 5. DELETE ──
export const deleteCategoryService = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service_category WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Kategori layanan tidak ditemukan" });
    }

    // Check if used in mst_service
    const [used] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE category_id = ?", [id]);
    if (used.length) {
      return res.status(400).json({ success: false, message: "Kategori tidak dapat dihapus karena masih digunakan pada Katalog Layanan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_service_category WHERE id = ?", [id]);
    res.json({ success: true, message: "Kategori layanan berhasil dihapus" });
  } catch (err) {
    console.error("deleteCategoryService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
