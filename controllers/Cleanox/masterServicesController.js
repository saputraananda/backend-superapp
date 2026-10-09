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
  const {
    name,
    price,
    satuan_id,
    satuan_name,
    category_id,
    duration_value,
    duration_unit,
    durasi_cuci_menit = 0,
    durasi_jemur_menit = 0,
    durasi_packing_menit = 0,
    durasi_blower_menit = 0,
    total_durasi_kerja_menit = 0,
    sla_hari = 0,
    kategori_kpi = null,
  } = req.body;

  if (!name || price == null) {
    return res.status(400).json({ message: "Nama dan Harga wajib diisi" });
  }

  const satuanIdVal = satuan_id !== undefined && satuan_id !== "" ? satuan_id : null;
  const satuanNameVal = satuan_name !== undefined && satuan_name !== "" ? satuan_name : null;
  const categoryIdVal = category_id !== undefined && category_id !== "" ? category_id : null;
  const durationValueVal = duration_value !== undefined && duration_value !== "" ? duration_value : null;
  const durationUnitVal = duration_unit !== undefined && duration_unit !== "" ? duration_unit : null;

  const cuci = Number(durasi_cuci_menit) || 0;
  const jemur = Number(durasi_jemur_menit) || 0;
  const packing = Number(durasi_packing_menit) || 0;
  const blower = Number(durasi_blower_menit) || 0;
  let total = Number(total_durasi_kerja_menit) || 0;
  if (total === 0 && (cuci > 0 || jemur > 0 || packing > 0)) {
    total = cuci + jemur + packing;
  }
  const sla = Number(sla_hari) || 0;

  try {
    const [result] = await safeCleanoxQuery(
      `
      INSERT INTO mst_services (
        name, price, satuan_id, satuan_name, category_id,
        duration_value, duration_unit,
        durasi_cuci_menit, durasi_jemur_menit, durasi_packing_menit, durasi_blower_menit,
        total_durasi_kerja_menit, sla_hari, kategori_kpi
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        name,
        price,
        satuanIdVal,
        satuanNameVal,
        categoryIdVal,
        durationValueVal,
        durationUnitVal,
        cuci,
        jemur,
        packing,
        blower,
        total,
        sla,
        kategori_kpi || null,
      ]
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
  const {
    name,
    price,
    satuan_id,
    satuan_name,
    category_id,
    duration_value,
    duration_unit,
    status,
    durasi_cuci_menit,
    durasi_jemur_menit,
    durasi_packing_menit,
    durasi_blower_menit,
    total_durasi_kerja_menit,
    sla_hari,
    kategori_kpi,
  } = req.body;

  if (!name || price == null) {
    return res.status(400).json({ message: "Nama dan Harga wajib diisi" });
  }

  const satuanIdVal = satuan_id !== undefined && satuan_id !== "" ? satuan_id : null;
  const satuanNameVal = satuan_name !== undefined && satuan_name !== "" ? satuan_name : null;
  const categoryIdVal = category_id !== undefined && category_id !== "" ? category_id : null;
  const durationValueVal = duration_value !== undefined && duration_value !== "" ? duration_value : null;
  const durationUnitVal = duration_unit !== undefined && duration_unit !== "" ? duration_unit : null;

  const cuci = durasi_cuci_menit !== undefined ? Number(durasi_cuci_menit) || 0 : undefined;
  const jemur = durasi_jemur_menit !== undefined ? Number(durasi_jemur_menit) || 0 : undefined;
  const packing = durasi_packing_menit !== undefined ? Number(durasi_packing_menit) || 0 : undefined;
  const blower = durasi_blower_menit !== undefined ? Number(durasi_blower_menit) || 0 : undefined;
  let total = total_durasi_kerja_menit !== undefined ? Number(total_durasi_kerja_menit) || 0 : undefined;
  if (total === 0 && cuci !== undefined && (cuci > 0 || jemur > 0 || packing > 0)) {
    total = (cuci || 0) + (jemur || 0) + (packing || 0);
  }
  const sla = sla_hari !== undefined ? Number(sla_hari) || 0 : undefined;

  try {
    await safeCleanoxQuery(
      `
      UPDATE mst_services
      SET name = ?, price = ?, satuan_id = ?, satuan_name = ?, category_id = ?,
          duration_value = ?, duration_unit = ?, status = ?,
          durasi_cuci_menit = COALESCE(?, durasi_cuci_menit),
          durasi_jemur_menit = COALESCE(?, durasi_jemur_menit),
          durasi_packing_menit = COALESCE(?, durasi_packing_menit),
          durasi_blower_menit = COALESCE(?, durasi_blower_menit),
          total_durasi_kerja_menit = COALESCE(?, total_durasi_kerja_menit),
          sla_hari = COALESCE(?, sla_hari),
          kategori_kpi = COALESCE(?, kategori_kpi)
      WHERE id = ?
    `,
      [
        name,
        price,
        satuanIdVal,
        satuanNameVal,
        categoryIdVal,
        durationValueVal,
        durationUnitVal,
        status || "Aktif",
        cuci,
        jemur,
        packing,
        blower,
        total,
        sla,
        kategori_kpi !== undefined ? kategori_kpi : null,
        id,
      ]
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
