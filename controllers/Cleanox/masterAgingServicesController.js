import { safeCleanoxQuery } from "../../db/pool.js";

export const DEFAULT_AGING_SERVICES = [
  {
    category_key: "FAST CLEAN KASUR",
    category_name: "Fast Clean Kasur",
    aging_days: 90,
    is_cross_selling: 0,
    keywords: "FAST CLEAN, FC, KASUR FC, CEPAT KASUR",
    description: "Pembersihan cepat untuk kasur dan matras",
  },
  {
    category_key: "BANTAL GULING",
    category_name: "Bantal Guling",
    aging_days: 90,
    is_cross_selling: 0,
    keywords: "BANTAL, GULING, CUSHION",
    description: "Perawatan dan pembersihan bantal & guling tidur",
  },
  {
    category_key: "SAJADAH",
    category_name: "Sajadah",
    aging_days: 90,
    is_cross_selling: 0,
    keywords: "SAJADAH, SEJADAH, PRAYER MAT",
    description: "Pembersihan sajadah perlengkapan ibadah",
  },
  {
    category_key: "STROLLER BAYI",
    category_name: "Stroller Bayi",
    aging_days: 90,
    is_cross_selling: 0,
    keywords: "STROLLER, KERETA BAYI, BABY CARRIER, CAR SEAT",
    description: "Perawatan higienis perlengkapan bayi",
  },
  {
    category_key: "GENERAL CLEANING",
    category_name: "General Cleaning",
    aging_days: 90,
    is_cross_selling: 0,
    keywords: "GENERAL CLEANING, GC, PEMBERSIHAN RUMAH",
    description: "Pembersihan umum menyeluruh area hunian",
  },
  {
    category_key: "DEEP CLEAN KASUR",
    category_name: "Deep Clean Kasur",
    aging_days: 180,
    is_cross_selling: 0,
    keywords: "DEEP CLEAN KASUR, DEEPCLEAN KASUR, DC KASUR, SPRINGBED, MATRAS, MATTRESS",
    description: "Pembersihan ekstra mendalam untuk matras dan kasur",
  },
  {
    category_key: "DEEP CLEAN SOFA KURSI",
    category_name: "Deep Clean Sofa Kursi",
    aging_days: 180,
    is_cross_selling: 0,
    keywords: "SOFA, KURSI, BANQUET, PUFF, BENCH, DINING CHAIR",
    description: "Pembersihan sofa dan kursi kain / kulit",
  },
  {
    category_key: "KARPET",
    category_name: "Karpet",
    aging_days: 180,
    is_cross_selling: 0,
    keywords: "KARPET, RUG, MAT",
    description: "Pencucian karpet rumah dan kantor",
  },
  {
    category_key: "GORDYN DAN VITRASE",
    category_name: "Gordyn dan Vitrase",
    aging_days: 180,
    is_cross_selling: 0,
    keywords: "GORDYN, GORDEN, VITRASE, TIRAI, CURTAIN",
    description: "Pembersihan gordyn dan vitrase jendela",
  },
  {
    category_key: "HEADBOARD",
    category_name: "Headboard",
    aging_days: 180,
    is_cross_selling: 0,
    keywords: "HEADBOARD, SANDARAN KASUR, DIPAN",
    description: "Pembersihan sandaran kepala tempat tidur",
  },
  {
    category_key: "KURSI DAN INTERIOR MOBIL",
    category_name: "Kursi dan Interior Mobil",
    aging_days: 60,
    is_cross_selling: 0,
    keywords: "MOBIL, PLAFON, HEADLINER, TRUNK, INTERIOR MOBIL, JOK MOBIL",
    description: "Pembersihan jok dan interior mobil",
  },
  {
    category_key: "SEPATU",
    category_name: "Sepatu",
    aging_days: 30,
    is_cross_selling: 0,
    keywords: "SEPATU, SHOES, SNEAKERS, BOOTS, LOAFERS",
    description: "Perawatan dan pencucian sepatu berkala",
  },
  {
    category_key: "TAS",
    category_name: "Tas",
    aging_days: 75,
    is_cross_selling: 0,
    keywords: "TAS, BAG, BACKPACK, TOTE, HANDBAG",
    description: "Perawatan tas kulit dan kain",
  },
  {
    category_key: "KOPER",
    category_name: "Koper",
    aging_days: null,
    is_cross_selling: 1,
    keywords: "KOPER, LUGGAGE, SUITCASE, TRAVEL BAG",
    description: "Layanan cuci koper add-on khusus cross-selling",
  },
];

let tableInitialized = false;

export async function ensureMasterAgingTable() {
  if (tableInitialized) return;
  try {
    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS mst_service_aging_configs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        category_key VARCHAR(100) NOT NULL UNIQUE,
        category_name VARCHAR(150) NOT NULL,
        aging_days INT NULL,
        is_cross_selling TINYINT(1) DEFAULT 0,
        keywords TEXT NULL,
        description TEXT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_active (is_active),
        INDEX idx_key (category_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Check if table has rows, if empty, seed default categories
    const [rows] = await safeCleanoxQuery("SELECT COUNT(*) AS total FROM mst_service_aging_configs");
    if (!rows || rows[0].total === 0) {
      console.log("🌱 Seeding default 14 master aging services...");
      for (const item of DEFAULT_AGING_SERVICES) {
        await safeCleanoxQuery(
          `INSERT INTO mst_service_aging_configs 
            (category_key, category_name, aging_days, is_cross_selling, keywords, description, is_active)
           VALUES (?, ?, ?, ?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE 
            category_name = VALUES(category_name),
            aging_days = VALUES(aging_days),
            is_cross_selling = VALUES(is_cross_selling),
            keywords = VALUES(keywords)`,
          [
            item.category_key,
            item.category_name,
            item.aging_days,
            item.is_cross_selling,
            item.keywords,
            item.description,
          ]
        );
      }
      console.log("✅ Seeding master aging services completed.");
    }

    tableInitialized = true;
  } catch (err) {
    console.error("[ensureMasterAgingTable Error]:", err.message);
  }
}

// Ensure table on module load
ensureMasterAgingTable();

/**
 * Helper to generate normalized key
 */
function normalizeKey(str) {
  return String(str || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * GET /cleanox/master-aging-services
 */
export async function getMasterAgingServices(req, res) {
  try {
    await ensureMasterAgingTable();
    const { search = "", status = "all", type = "all" } = req.query;

    let sql = "SELECT * FROM mst_service_aging_configs WHERE 1=1";
    const params = [];

    if (status === "active") {
      sql += " AND is_active = 1";
    } else if (status === "inactive") {
      sql += " AND is_active = 0";
    }

    if (type === "periodic") {
      sql += " AND is_cross_selling = 0";
    } else if (type === "cross_selling") {
      sql += " AND is_cross_selling = 1";
    }

    if (search.trim()) {
      const q = `%${search.trim()}%`;
      sql += " AND (category_name LIKE ? OR category_key LIKE ? OR keywords LIKE ? OR description LIKE ?)";
      params.push(q, q, q, q);
    }

    sql += " ORDER BY is_cross_selling ASC, aging_days ASC, id ASC";

    const [rows] = await safeCleanoxQuery(sql, params);

    // Calculate quick stats
    const [statRows] = await safeCleanoxQuery(`
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS total_active,
        SUM(CASE WHEN is_cross_selling = 0 AND is_active = 1 THEN 1 ELSE 0 END) AS total_periodic,
        SUM(CASE WHEN is_cross_selling = 1 AND is_active = 1 THEN 1 ELSE 0 END) AS total_cross_selling,
        ROUND(AVG(CASE WHEN is_cross_selling = 0 AND is_active = 1 THEN aging_days ELSE NULL END), 0) AS avg_aging_days
      FROM mst_service_aging_configs
    `);

    return res.json({
      success: true,
      data: rows || [],
      stats: statRows[0] || {
        total: 0,
        total_active: 0,
        total_periodic: 0,
        total_cross_selling: 0,
        avg_aging_days: 0,
      },
    });
  } catch (err) {
    console.error("[getMasterAgingServices Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal memuat data master aging layanan", error: err.message });
  }
}

/**
 * POST /cleanox/master-aging-services
 */
export async function createMasterAgingService(req, res) {
  try {
    await ensureMasterAgingTable();
    const {
      category_name,
      category_key,
      aging_days,
      is_cross_selling = 0,
      keywords = "",
      description = "",
      is_active = 1,
    } = req.body;

    if (!category_name || !category_name.trim()) {
      return res.status(400).json({ success: false, message: "Nama layanan wajib diisi" });
    }

    const key = category_key ? normalizeKey(category_key) : normalizeKey(category_name);
    if (!key) {
      return res.status(400).json({ success: false, message: "Kode/Key kategori tidak valid" });
    }

    const crossSellingFlag = Number(is_cross_selling) === 1 ? 1 : 0;
    const days = crossSellingFlag ? null : Number(aging_days) > 0 ? Number(aging_days) : 30;

    const [existing] = await safeCleanoxQuery(
      "SELECT id FROM mst_service_aging_configs WHERE category_key = ? LIMIT 1",
      [key]
    );

    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, message: `Key "${key}" sudah terdaftar. Gunakan nama yang berbeda.` });
    }

    const [result] = await safeCleanoxQuery(
      `INSERT INTO mst_service_aging_configs 
        (category_key, category_name, aging_days, is_cross_selling, keywords, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        key,
        category_name.trim(),
        days,
        crossSellingFlag,
        keywords.trim(),
        description.trim(),
        is_active ? 1 : 0,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Layanan aging berhasil ditambahkan",
      id: result.insertId,
    });
  } catch (err) {
    console.error("[createMasterAgingService Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal menambahkan layanan aging", error: err.message });
  }
}

/**
 * PUT /cleanox/master-aging-services/:id
 */
export async function updateMasterAgingService(req, res) {
  try {
    await ensureMasterAgingTable();
    const { id } = req.params;
    const {
      category_name,
      category_key,
      aging_days,
      is_cross_selling = 0,
      keywords = "",
      description = "",
      is_active = 1,
    } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: "ID tidak valid" });
    }

    if (!category_name || !category_name.trim()) {
      return res.status(400).json({ success: false, message: "Nama layanan wajib diisi" });
    }

    const key = category_key ? normalizeKey(category_key) : normalizeKey(category_name);
    const crossSellingFlag = Number(is_cross_selling) === 1 ? 1 : 0;
    const days = crossSellingFlag ? null : Number(aging_days) > 0 ? Number(aging_days) : 30;

    // Check duplicate key on another id
    const [existing] = await safeCleanoxQuery(
      "SELECT id FROM mst_service_aging_configs WHERE category_key = ? AND id != ? LIMIT 1",
      [key, id]
    );
    if (existing && existing.length > 0) {
      return res.status(400).json({ success: false, message: `Key "${key}" sudah digunakan oleh layanan lain.` });
    }

    await safeCleanoxQuery(
      `UPDATE mst_service_aging_configs 
       SET category_key = ?,
           category_name = ?,
           aging_days = ?,
           is_cross_selling = ?,
           keywords = ?,
           description = ?,
           is_active = ?
       WHERE id = ?`,
      [
        key,
        category_name.trim(),
        days,
        crossSellingFlag,
        keywords.trim(),
        description.trim(),
        is_active ? 1 : 0,
        id,
      ]
    );

    return res.json({
      success: true,
      message: "Konfigurasi layanan aging berhasil diperbarui",
    });
  } catch (err) {
    console.error("[updateMasterAgingService Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal memperbarui layanan aging", error: err.message });
  }
}

/**
 * DELETE /cleanox/master-aging-services/:id
 */
export async function deleteMasterAgingService(req, res) {
  try {
    await ensureMasterAgingTable();
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, message: "ID tidak valid" });
    }

    await safeCleanoxQuery("DELETE FROM mst_service_aging_configs WHERE id = ?", [id]);

    return res.json({
      success: true,
      message: "Layanan aging berhasil dihapus",
    });
  } catch (err) {
    console.error("[deleteMasterAgingService Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal menghapus layanan aging", error: err.message });
  }
}
