import { safeCleanoxQuery } from "../../db/pool.js";

// Initialize tables (if not already done)
const initDb = async () => {
  try {
    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS mst_target_cleanox (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        outlet varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
        tahun smallint unsigned NOT NULL,
        bulan tinyint unsigned NOT NULL,
        nominal int NOT NULL DEFAULT '0',
        created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_outlet_tahun_bulan (outlet, tahun, bulan),
        CONSTRAINT target_cleanox_chk_1 CHECK ((bulan between 1 and 12))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
    `);
  } catch (err) {
    console.error("❌ Failed to initialize Cleanox mst_target_cleanox table:", err.message);
  }
};
initDb();

// ── GET ALL TARGETS ────────────────────────────────────────
export const getTargets = async (req, res) => {
  try {
    const { tahun, bulan } = req.query;
    let sql = "SELECT id, outlet, tahun, bulan, nominal, created_at, updated_at FROM mst_target_cleanox";
    const params = [];
    const conditions = [];

    if (tahun) {
      conditions.push("tahun = ?");
      params.push(Number(tahun));
    }
    if (bulan) {
      conditions.push("bulan = ?");
      params.push(Number(bulan));
    }

    if (conditions.length) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY tahun DESC, bulan DESC, outlet ASC";

    const [rows] = await safeCleanoxQuery(sql, params);
    return res.json({ targets: rows });
  } catch (err) {
    console.error("[targetCleanox/getTargets]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data target Cleanox", error: err.message });
  }
};

// ── CREATE TARGET ──────────────────────────────────────────
export const createTarget = async (req, res) => {
  const { outlet, tahun, bulan, nominal } = req.body;

  if (tahun === undefined || tahun === null || bulan === undefined || bulan === null || nominal === undefined || nominal === null) {
    return res.status(400).json({ message: "tahun, bulan, dan nominal wajib diisi" });
  }

  const intBulan = Number(bulan);
  if (intBulan < 1 || intBulan > 12) {
    return res.status(400).json({ message: "bulan harus antara 1-12" });
  }

  const targetOutlet = outlet && outlet.trim() ? outlet.trim() : null;

  try {
    // Check duplication manually (since MySQL unique constraints allow multiple NULLs)
    const [existing] = await safeCleanoxQuery(
      "SELECT id FROM mst_target_cleanox WHERE (outlet = ? OR (outlet IS NULL AND ? IS NULL)) AND tahun = ? AND bulan = ?",
      [targetOutlet, targetOutlet, Number(tahun), intBulan]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "Target untuk outlet, tahun, dan bulan ini sudah ada" });
    }

    await safeCleanoxQuery(
      "INSERT INTO mst_target_cleanox (outlet, tahun, bulan, nominal) VALUES (?, ?, ?, ?)",
      [targetOutlet, Number(tahun), intBulan, Number(nominal)]
    );
    return res.status(201).json({ message: "Target Cleanox berhasil ditambahkan" });
  } catch (err) {
    console.error("[targetCleanox/createTarget]", err.message);
    return res.status(500).json({ message: "Gagal menambahkan target Cleanox", error: err.message });
  }
};

// ── UPDATE TARGET ──────────────────────────────────────────
export const updateTarget = async (req, res) => {
  const { id } = req.params;
  const { outlet, tahun, bulan, nominal } = req.body;

  if (tahun === undefined || tahun === null || bulan === undefined || bulan === null || nominal === undefined || nominal === null) {
    return res.status(400).json({ message: "tahun, bulan, dan nominal wajib diisi" });
  }

  const intBulan = Number(bulan);
  if (intBulan < 1 || intBulan > 12) {
    return res.status(400).json({ message: "bulan harus antara 1-12" });
  }

  const targetOutlet = outlet && outlet.trim() ? outlet.trim() : null;

  try {
    // Check duplication manually
    const [existing] = await safeCleanoxQuery(
      "SELECT id FROM mst_target_cleanox WHERE (outlet = ? OR (outlet IS NULL AND ? IS NULL)) AND tahun = ? AND bulan = ? AND id <> ?",
      [targetOutlet, targetOutlet, Number(tahun), intBulan, id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "Target untuk outlet, tahun, dan bulan ini sudah ada" });
    }

    await safeCleanoxQuery(
      "UPDATE mst_target_cleanox SET outlet = ?, tahun = ?, bulan = ?, nominal = ? WHERE id = ?",
      [targetOutlet, Number(tahun), intBulan, Number(nominal), id]
    );
    return res.json({ message: "Target Cleanox berhasil diperbarui" });
  } catch (err) {
    console.error("[targetCleanox/updateTarget]", err.message);
    return res.status(500).json({ message: "Gagal memperbarui target Cleanox", error: err.message });
  }
};

// ── DELETE TARGET ──────────────────────────────────────────
export const deleteTarget = async (req, res) => {
  const { id } = req.params;
  try {
    await safeCleanoxQuery("DELETE FROM mst_target_cleanox WHERE id = ?", [id]);
    return res.json({ message: "Target Cleanox berhasil dihapus" });
  } catch (err) {
    console.error("[targetCleanox/deleteTarget]", err.message);
    return res.status(500).json({ message: "Gagal menghapus target Cleanox", error: err.message });
  }
};
