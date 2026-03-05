import { pool } from "../db/pool.js";

async function getSessionEmployee(req) {
  const userId = req.session?.userId;
  if (!userId) return null;
  const [[emp]] = await pool.query(
    `SELECT e.employee_id, e.full_name, e.job_level_id
     FROM mst_employee e
     JOIN users u ON u.id = e.employee_id
     WHERE u.id = ? AND e.exit_date IS NULL LIMIT 1`,
    [userId]
  );
  return emp || null;
}

// ── GET /broadcast — ambil semua yang aktif & belum expired ──────────────────
export async function listBroadcasts(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, description, type, starts_at, expires_at,
              creator_name, created_at,
              TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS seconds_left
       FROM tr_broadcast
       WHERE is_active = 1
         AND starts_at  <= NOW()
         AND expires_at  > NOW()
       ORDER BY
         FIELD(type, 'urgent','warning','info','success'),
         created_at DESC`
    );
    return res.json({ broadcasts: rows });
  } catch (err) {
    console.error("[broadcast] listBroadcasts:", err);
    return res.status(500).json({ message: "Gagal memuat broadcast" });
  }
}

// ── GET /broadcast/all — semua (admin) ───────────────────────────────────────
export async function listAllBroadcasts(req, res) {
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await pool.query(
      `SELECT id, title, description, type, is_active,
              starts_at, expires_at, creator_name, created_at, updated_at,
              CASE
                WHEN is_active = 0           THEN 'nonaktif'
                WHEN expires_at <= NOW()     THEN 'expired'
                WHEN starts_at  >  NOW()     THEN 'scheduled'
                ELSE 'aktif'
              END AS status_label
       FROM tr_broadcast
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return res.json({ broadcasts: rows });
  } catch (err) {
    console.error("[broadcast] listAll:", err);
    return res.status(500).json({ message: "Gagal memuat broadcast" });
  }
}

// ── POST /broadcast — buat baru ──────────────────────────────────────────────
export async function createBroadcast(req, res) {
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { title, description, type = "info", starts_at, expires_at } = req.body;

    if (!title?.trim())       return res.status(400).json({ message: "Judul wajib diisi" });
    if (!description?.trim()) return res.status(400).json({ message: "Deskripsi wajib diisi" });
    if (!expires_at)          return res.status(400).json({ message: "Tanggal kadaluarsa wajib diisi" });

    const validTypes = ["info", "warning", "success", "urgent"];
    if (!validTypes.includes(type)) return res.status(400).json({ message: "Tipe tidak valid" });

    const startDate  = starts_at  ? new Date(starts_at)  : new Date();
    const expireDate = new Date(expires_at);

    if (expireDate <= startDate) {
      return res.status(400).json({ message: "Tanggal kadaluarsa harus lebih dari tanggal mulai" });
    }

    const [result] = await pool.query(
      `INSERT INTO tr_broadcast
         (title, description, type, starts_at, expires_at, creator_id, creator_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(),
        description.trim(),
        type,
        startDate,
        expireDate,
        emp.employee_id,
        emp.full_name,
      ]
    );

    const [[created]] = await pool.query(
      `SELECT * FROM tr_broadcast WHERE id = ?`, [result.insertId]
    );

    return res.status(201).json({ message: "Broadcast berhasil dibuat", broadcast: created });
  } catch (err) {
    console.error("[broadcast] create:", err);
    return res.status(500).json({ message: "Gagal membuat broadcast" });
  }
}

// ── PATCH /broadcast/:id — update ───────────────────────────────────────────
export async function updateBroadcast(req, res) {
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { title, description, type, starts_at, expires_at, is_active } = req.body;

    const [[existing]] = await pool.query(
      `SELECT * FROM tr_broadcast WHERE id = ?`, [id]
    );
    if (!existing) return res.status(404).json({ message: "Broadcast tidak ditemukan" });

    await pool.query(
      `UPDATE tr_broadcast SET
         title       = COALESCE(?, title),
         description = COALESCE(?, description),
         type        = COALESCE(?, type),
         starts_at   = COALESCE(?, starts_at),
         expires_at  = COALESCE(?, expires_at),
         is_active   = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        title?.trim()       || null,
        description?.trim() || null,
        type                || null,
        starts_at           || null,
        expires_at          || null,
        is_active != null ? is_active : null,
        id,
      ]
    );

    const [[updated]] = await pool.query(
      `SELECT * FROM tr_broadcast WHERE id = ?`, [id]
    );
    return res.json({ message: "Broadcast diperbarui", broadcast: updated });
  } catch (err) {
    console.error("[broadcast] update:", err);
    return res.status(500).json({ message: "Gagal memperbarui broadcast" });
  }
}

// ── DELETE /broadcast/:id — hapus permanen ───────────────────────────────────
export async function deleteBroadcast(req, res) {
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const [[existing]] = await pool.query(
      `SELECT id FROM tr_broadcast WHERE id = ?`, [id]
    );
    if (!existing) return res.status(404).json({ message: "Broadcast tidak ditemukan" });

    await pool.query(`DELETE FROM tr_broadcast WHERE id = ?`, [id]);
    return res.json({ message: "Broadcast dihapus" });
  } catch (err) {
    console.error("[broadcast] delete:", err);
    return res.status(500).json({ message: "Gagal menghapus broadcast" });
  }
}