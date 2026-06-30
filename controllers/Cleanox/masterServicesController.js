import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";

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
        satuan_id INT NOT NULL,
        satuan_name VARCHAR(100) NOT NULL,
        category_id INT NOT NULL,
        duration_value INT NOT NULL,
        duration_unit ENUM('hari', 'minggu', 'bulan') NOT NULL,
        status VARCHAR(20) DEFAULT 'Aktif',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES mst_category(id)
      )
    `);

    // Seed default categories
    const [cats] = await safeCleanoxQuery("SELECT COUNT(*) as count FROM mst_category");
    if (cats[0].count === 0) {
      await safeCleanoxQuery("INSERT INTO mst_category (name) VALUES ('Kiloan'), ('Satuan'), ('Dry Clean'), ('Special')");
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

  if (!name || price == null || !satuan_id || !satuan_name || !category_id || !duration_value || !duration_unit) {
    return res.status(400).json({ message: "Semua kolom wajib diisi" });
  }

  try {
    await safeCleanoxQuery(`
      INSERT INTO mst_services (name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit]);

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

  if (!name || price == null || !satuan_id || !satuan_name || !category_id || !duration_value || !duration_unit) {
    return res.status(400).json({ message: "Semua kolom wajib diisi" });
  }

  try {
    await safeCleanoxQuery(`
      UPDATE mst_services
      SET name = ?, price = ?, satuan_id = ?, satuan_name = ?, category_id = ?, duration_value = ?, duration_unit = ?, status = ?
      WHERE id = ?
    `, [name, price, satuan_id, satuan_name, category_id, duration_value, duration_unit, status || 'Aktif', id]);

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
