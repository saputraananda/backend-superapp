import { safeCleanoxQuery } from "../../db/pool.js";

// Initialize tables (if not already done)
const initDb = async () => {
  try {
    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS mst_category (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } catch (err) {
    console.error("❌ Failed to initialize Cleanox mst_category table:", err.message);
  }
};
initDb();

// ── GET ALL CATEGORIES ────────────────────────────────────
export const getCategories = async (req, res) => {
  try {
    const [rows] = await safeCleanoxQuery("SELECT * FROM mst_category ORDER BY id DESC");
    return res.json({ categories: rows });
  } catch (err) {
    console.error("[masterCategory/getCategories]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data kategori", error: err.message });
  }
};

// ── CREATE CATEGORY ───────────────────────────────────────
export const createCategory = async (req, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Nama kategori wajib diisi" });
  }

  try {
    await safeCleanoxQuery("INSERT INTO mst_category (name) VALUES (?)", [name]);
    return res.status(201).json({ message: "Kategori berhasil dibuat" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Nama kategori sudah terdaftar" });
    }
    console.error("[masterCategory/createCategory]", err.message);
    return res.status(500).json({ message: "Gagal membuat kategori", error: err.message });
  }
};

// ── UPDATE CATEGORY ───────────────────────────────────────
export const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Nama kategori wajib diisi" });
  }

  try {
    await safeCleanoxQuery("UPDATE mst_category SET name = ? WHERE id = ?", [name, id]);
    return res.json({ message: "Kategori berhasil diupdate" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Nama kategori sudah digunakan" });
    }
    console.error("[masterCategory/updateCategory]", err.message);
    return res.status(500).json({ message: "Gagal mengupdate kategori", error: err.message });
  }
};

// ── DELETE CATEGORY ───────────────────────────────────────
export const deleteCategory = async (req, res) => {
  const { id } = req.params;
  try {
    // Check if category is used in mst_services
    const [usage] = await safeCleanoxQuery("SELECT COUNT(*) as count FROM mst_services WHERE category_id = ?", [id]);
    if (usage[0] && usage[0].count > 0) {
      return res.status(400).json({ message: "Kategori tidak dapat dihapus karena masih digunakan oleh layanan" });
    }

    await safeCleanoxQuery("DELETE FROM mst_category WHERE id = ?", [id]);
    return res.json({ message: "Kategori berhasil dihapus" });
  } catch (err) {
    console.error("[masterCategory/deleteCategory]", err.message);
    return res.status(500).json({ message: "Gagal menghapus kategori", error: err.message });
  }
};
