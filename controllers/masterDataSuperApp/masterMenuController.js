import { safeQuery } from "../../db/pool.js";

const getNextAppId = async () => {
  const [[{ maxId }]] = await safeQuery(
    `SELECT COALESCE(MAX(CAST(id AS UNSIGNED)), 0) AS maxId FROM mst_apps`
  );
  return Number(maxId || 0) + 1;
};

// ── GET ALL APPS ───────────────────────────────────────────────────────────
export const getApps = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT id, name, description, href, authorization, is_active, sort_order, created_at, updated_at
       FROM mst_apps
       ORDER BY sort_order ASC`
    );
    const apps = rows.map((r) => ({
      ...r,
      authorization: r.authorization
        ? r.authorization.split(",").map((x) => x.trim()).filter(Boolean)
        : [],
    }));
    res.json({ apps });
  } catch (error) {
    console.error("getApps error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET APP BY ID ──────────────────────────────────────────────────────────
export const getAppById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_apps WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ message: "App tidak ditemukan" });
    const app = {
      ...rows[0],
      authorization: rows[0].authorization
        ? rows[0].authorization.split(",").map((x) => x.trim()).filter(Boolean)
        : [],
    };
    res.json({ app });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── CREATE APP ─────────────────────────────────────────────────────────────
export const createApp = async (req, res) => {
  const { name, description, href, authorization, is_active } = req.body;

  if (!name)        return res.status(400).json({ message: "Nama wajib diisi" });
  if (!href)        return res.status(400).json({ message: "Path (href) wajib diisi" });
  if (!authorization || authorization.length === 0)
    return res.status(400).json({ message: "Minimal pilih 1 role" });

  try {
    const [existHref] = await safeQuery(`SELECT id FROM mst_apps WHERE href = ?`, [href]);
    if (existHref.length > 0)
      return res.status(409).json({ message: "Path sudah digunakan app lain" });

    const nextId = await getNextAppId();

    const [[{ maxOrder }]] = await safeQuery(`SELECT MAX(sort_order) as maxOrder FROM mst_apps`);
    const nextOrder = (maxOrder ?? 0) + 1;

    const authStr = Array.isArray(authorization)
      ? authorization.join(",")
      : authorization;

    await safeQuery(
      `INSERT INTO mst_apps (id, name, description, href, authorization, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nextId, name, description || null, href, authStr, is_active ? 1 : 0, nextOrder]
    );

    res.status(201).json({ message: "App berhasil ditambahkan", id: nextId });
  } catch (error) {
    console.error("createApp error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── UPDATE APP ─────────────────────────────────────────────────────────────
export const updateApp = async (req, res) => {
  const { id } = req.params;
  const { name, description, href, authorization, is_active, sort_order } = req.body;

  if (!name) return res.status(400).json({ message: "Nama wajib diisi" });
  if (!href) return res.status(400).json({ message: "Path (href) wajib diisi" });
  if (!authorization || authorization.length === 0)
    return res.status(400).json({ message: "Minimal pilih 1 role" });

  try {
    const [exist] = await safeQuery(`SELECT id FROM mst_apps WHERE id = ?`, [id]);
    if (exist.length === 0) return res.status(404).json({ message: "App tidak ditemukan" });

    const [existHref] = await safeQuery(
      `SELECT id FROM mst_apps WHERE href = ? AND id != ?`, [href, id]
    );
    if (existHref.length > 0)
      return res.status(409).json({ message: "Path sudah digunakan app lain" });

    const authStr = Array.isArray(authorization)
      ? authorization.join(",")
      : authorization;

    await safeQuery(
      `UPDATE mst_apps SET name=?, description=?, href=?, authorization=?, is_active=?, sort_order=?, updated_at=NOW()
       WHERE id=?`,
      [name, description || null, href, authStr, is_active ? 1 : 0, sort_order, id]
    );

    res.json({ message: "App berhasil diperbarui" });
  } catch (error) {
    console.error("updateApp error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── DELETE APP ─────────────────────────────────────────────────────────────
export const deleteApp = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeQuery(`SELECT id FROM mst_apps WHERE id = ?`, [id]);
    if (exist.length === 0) return res.status(404).json({ message: "App tidak ditemukan" });

    await safeQuery(`DELETE FROM mst_apps WHERE id = ?`, [id]);
    res.json({ message: "App berhasil dihapus" });
  } catch (error) {
    console.error("deleteApp error:", error);
    res.status(500).json({ message: error.message });
  }
};
