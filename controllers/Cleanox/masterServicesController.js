import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";

function toMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

/** Sync POS price row. On duplicate, update price only — never null out existing coret_price. */
async function upsertServicePrice(serviceId, price) {
  const money = toMoney(price);
  await safeCleanoxQuery(
    `
      INSERT INTO mst_service_prices (service_id, price, coret_price, created_at, updated_at)
      VALUES (?, ?, NULL, CURRENT_TIMESTAMP(0), CURRENT_TIMESTAMP(0))
      ON DUPLICATE KEY UPDATE
        price = VALUES(price),
        updated_at = CURRENT_TIMESTAMP(0)
    `,
    [serviceId, money]
  );
}

// Initialize tables
const initDb = async () => {
  try {
    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS mst_category (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS mst_services (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        price DECIMAL(15,2) NOT NULL,
        satuan_id INT NULL,
        satuan_name VARCHAR(100) NULL,
        category_id INT NULL,
        duration_value INT NULL,
        duration_unit ENUM('jam', 'hari', 'minggu', 'bulan') NULL,
        status VARCHAR(20) DEFAULT 'Aktif',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES mst_category(id)
      )
    `);

    // Ensure duration_unit supports 'jam' and is nullable in existing databases
    try {
      await safeCleanoxQuery(`
        ALTER TABLE mst_services MODIFY COLUMN duration_unit ENUM('jam', 'hari', 'minggu', 'bulan') NULL
      `);
    } catch (err) {
      console.warn("⚠️ [initDb] Could not modify duration_unit column:", err.message);
    }

    // Seed default categories
    const [cats] = await safeCleanoxQuery("SELECT COUNT(*) as count FROM mst_category");
    if (cats[0].count === 0) {
      await safeCleanoxQuery("INSERT INTO mst_category (name) VALUES ('Kiloan'), ('Satuan'), ('Dry Clean'), ('Special')");
    }

    // Backfill POS prices for services created from Superapp without mst_service_prices
    try {
      await safeCleanoxQuery(`
        INSERT INTO mst_service_prices (service_id, price, created_at, updated_at)
        SELECT s.id, s.price,
               COALESCE(s.created_at, CURRENT_TIMESTAMP(0)),
               COALESCE(s.updated_at, CURRENT_TIMESTAMP(0))
        FROM mst_services s
        LEFT JOIN mst_service_prices sp ON sp.service_id = s.id
        WHERE sp.id IS NULL
      `);
    } catch (err) {
      console.warn("⚠️ [initDb] Could not backfill mst_service_prices:", err.message);
    }
  } catch (err) {
    console.error("❌ Failed to initialize Cleanox Master Service tables:", err.message);
  }
};
initDb();

// ── GET ALL SERVICES ──────────────────────────────────────
export const getServices = async (req, res) => {
  try {
    const [rows] = await safeCleanoxQuery(`
      SELECT s.*, c.name AS category_name 
      FROM mst_services s
      LEFT JOIN mst_category c ON s.category_id = c.id
      ORDER BY s.id DESC
    `);
    return res.json({ services: rows });
  } catch (err) {
    console.error("[masterServices/getServices]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data layanan", error: err.message });
  }
};

// ── CREATE SERVICE ────────────────────────────────────────
export const createService = async (req, res) => {
  const { name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit } = req.body;

  if (!name || price == null) {
    return res.status(400).json({ message: "Nama dan Harga wajib diisi" });
  }

  const satuanIdVal = satuan_id !== undefined && satuan_id !== "" ? satuan_id : null;
  const satuanNameVal = satuan_name !== undefined && satuan_name !== "" ? satuan_name : null;
  const categoryIdVal = category_id !== undefined && category_id !== "" ? category_id : null;
  const durationValueVal = duration_value !== undefined && duration_value !== "" ? duration_value : null;
  const durationUnitVal = duration_unit !== undefined && duration_unit !== "" ? duration_unit : null;

  try {
    const [result] = await safeCleanoxQuery(
      `
      INSERT INTO mst_services (name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [name, price, satuanIdVal, satuanNameVal, categoryIdVal, durationValueVal, durationUnitVal]
    );

    await upsertServicePrice(result.insertId, price);

    return res.status(201).json({ message: "Layanan berhasil dibuat" });
  } catch (err) {
    console.error("[masterServices/createService]", err.message);
    return res.status(500).json({ message: "Gagal membuat layanan", error: err.message });
  }
};

// ── UPDATE SERVICE ────────────────────────────────────────
export const updateService = async (req, res) => {
  const { id } = req.params;
  const { name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit, status } = req.body;

  if (!name || price == null) {
    return res.status(400).json({ message: "Nama dan Harga wajib diisi" });
  }

  const satuanIdVal = satuan_id !== undefined && satuan_id !== "" ? satuan_id : null;
  const satuanNameVal = satuan_name !== undefined && satuan_name !== "" ? satuan_name : null;
  const categoryIdVal = category_id !== undefined && category_id !== "" ? category_id : null;
  const durationValueVal = duration_value !== undefined && duration_value !== "" ? duration_value : null;
  const durationUnitVal = duration_unit !== undefined && duration_unit !== "" ? duration_unit : null;

  try {
    await safeCleanoxQuery(
      `
      UPDATE mst_services
      SET name = ?, price = ?, satuan_id = ?, satuan_name = ?, category_id = ?, duration_value = ?, duration_unit = ?, status = ?
      WHERE id = ?
    `,
      [name, price, satuanIdVal, satuanNameVal, categoryIdVal, durationValueVal, durationUnitVal, status || "Aktif", id]
    );

    await upsertServicePrice(id, price);

    return res.json({ message: "Layanan berhasil diupdate" });
  } catch (err) {
    console.error("[masterServices/updateService]", err.message);
    return res.status(500).json({ message: "Gagal mengupdate layanan", error: err.message });
  }
};

// ── DELETE SERVICE ────────────────────────────────────────
export const deleteService = async (req, res) => {
  const { id } = req.params;
  try {
    await safeCleanoxQuery("DELETE FROM mst_service_promos WHERE service_id = ?", [id]);
    await safeCleanoxQuery("DELETE FROM mst_service_prices WHERE service_id = ?", [id]);
    await safeCleanoxQuery("DELETE FROM mst_services WHERE id = ?", [id]);
    return res.json({ message: "Layanan berhasil dihapus" });
  } catch (err) {
    console.error("[masterServices/deleteService]", err.message);
    return res.status(500).json({ message: "Gagal menghapus layanan", error: err.message });
  }
};

// ── GET CATEGORIES ────────────────────────────────────────
export const getCategories = async (req, res) => {
  try {
    const [rows] = await safeCleanoxQuery("SELECT * FROM mst_category ORDER BY name ASC");
    return res.json({ categories: rows });
  } catch (err) {
    console.error("[masterServices/getCategories]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data kategori", error: err.message });
  }
};

// ── GET SATUAN ───────────────────────────────────────────
export const getSatuans = async (req, res) => {
  try {
    const [rows] = await safeQuery(`
      SELECT satuan_id, satuan_name 
      FROM mst_satuan 
      WHERE is_active = 1 
      ORDER BY satuan_name ASC
    `);
    return res.json({ satuans: rows });
  } catch (err) {
    console.error("[masterServices/getSatuans]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data satuan", error: err.message });
  }
};
