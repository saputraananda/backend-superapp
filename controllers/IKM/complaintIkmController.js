import { safeIKMQuery } from "../../db/pool.js";
import { resolveActor } from "./masterRsIkmController.js";
import { notifyLinenMonitoring, resolveLinenMonitoringUrl } from "../../utils/notifyLinenMonitoring.js";

// Admin Alora memantau komplain RS/Unit (tabel tr_complaint* di DB ikm, dibuat oleh linen-monitoring-system).
// Admin bisa melihat semua komplain sejak diajukan, menyetujui/menolak mewakili Tim Linen RS (kondisional),
// mengubah status lanjutan, dan menambahkan catatan yang langsung terlihat oleh Unit dan Tim Linen RS.

const STATUSES = ["DIAJUKAN", "DISETUJUI_RS", "DIPROSES", "SELESAI", "DITOLAK"];
// Transisi status oleh admin:
// - DIAJUKAN     -> DISETUJUI_RS / DITOLAK : admin MEWAKILI Tim Linen RS (kondisional, alasan wajib)
// - DISETUJUI_RS -> DIPROSES / SELESAI / DITOLAK
// - DIPROSES     -> SELESAI / DITOLAK
const ADMIN_TRANSITIONS = {
  DIAJUKAN: ["DISETUJUI_RS", "DITOLAK"],
  DISETUJUI_RS: ["DIPROSES", "SELESAI", "DITOLAK"],
  DIPROSES: ["SELESAI", "DITOLAK"],
};
const ADMIN_TARGETS = ["DISETUJUI_RS", "DIPROSES", "SELESAI", "DITOLAK"];

const clean = (v, max) => String(v ?? "").trim().slice(0, max);

// Nama tampil linen: nama RS jika ada, jika tidak nama linen + ukuran + warna + bahan
const LINEN_NAME_SQL = "COALESCE(NULLIF(TRIM(hl.hospital_linen_name), ''), TRIM(CONCAT_WS(' ', l.linen_name, s.size_name, co.color_name, m.material_name)))";

const SELECT_LIST = `
  SELECT c.id, c.complaint_number, c.hospital_id, h.hospital_name, c.room_id, r.room_name, c.reporter_name,
         DATE_FORMAT(c.complaint_date, '%Y-%m-%d') AS complaint_date,
         c.complaint_type, c.description, c.hospital_linen_id,
         ${LINEN_NAME_SQL} AS linen_name,
         lc.category_name, c.ownership_type, c.quantity, c.status, c.rs_approved_by, c.rs_approved_at,
         c.created_by_role, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM tr_complaint_doc d WHERE d.complaint_id = c.id) AS photo_count
  FROM tr_complaint c
  LEFT JOIN mst_hospital h ON h.id = c.hospital_id
  LEFT JOIN mst_rooms_rs r ON r.id = c.room_id
  LEFT JOIN mst_hospital_linen hl ON hl.id = c.hospital_linen_id
  LEFT JOIN mst_linen l ON l.id = hl.linen_id
  LEFT JOIN mst_size s ON s.id = l.size_id
  LEFT JOIN mst_color co ON co.id = l.color_id
  LEFT JOIN mst_material m ON m.id = l.material_id
  LEFT JOIN mst_linen_category lc ON lc.id = c.linen_category_id`;

const fail = (res, tag, err) => {
  console.error(`${tag}:`, err);
  return res.status(500).json({ message: err.message });
};

export const listComplaints = async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.hospital_id) { where.push("c.hospital_id = ?"); params.push(Number(req.query.hospital_id)); }
    if (STATUSES.includes(req.query.status)) { where.push("c.status = ?"); params.push(req.query.status); }
    const q = clean(req.query.q, 100);
    if (q) {
      where.push("(c.complaint_number LIKE ? OR c.complaint_type LIKE ? OR c.reporter_name LIKE ? OR c.description LIKE ? OR h.hospital_name LIKE ?)");
      params.push(...Array(5).fill(`%${q}%`));
    }
    const [rows] = await safeIKMQuery(
      `${SELECT_LIST} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC, c.id DESC LIMIT 1000`,
      params
    );
    const [counts] = await safeIKMQuery("SELECT status, COUNT(*) AS n FROM tr_complaint GROUP BY status");
    res.json({
      data: rows.map((c) => ({ ...c, can_update_status: !!ADMIN_TRANSITIONS[c.status] })),
      summary: Object.fromEntries(STATUSES.map((s) => [s, Number(counts.find((x) => x.status === s)?.n || 0)])),
    });
  } catch (err) { fail(res, "listComplaints", err); }
};

export const getComplaint = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(`${SELECT_LIST} WHERE c.id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Komplain tidak ditemukan" });
    const [docs] = await safeIKMQuery("SELECT id, file_name, original_name FROM tr_complaint_doc WHERE complaint_id = ? ORDER BY id", [req.params.id]);
    const [logs] = await safeIKMQuery(
      `SELECT id, action, from_status, to_status, note, detail, actor_name, actor_role, created_at
         FROM tr_complaint_log WHERE complaint_id = ? ORDER BY id`, [req.params.id]);
    const base = resolveLinenMonitoringUrl();
    res.json({
      data: {
        ...rows[0],
        can_update_status: !!ADMIN_TRANSITIONS[rows[0].status],
        photos: docs.map((d) => ({ id: d.id, name: d.original_name, url: `${base}/storage/assets/complaint/${encodeURIComponent(d.file_name)}` })),
        logs,
      },
    });
  } catch (err) { fail(res, "getComplaint", err); }
};

// Ubah status dan/atau tambah catatan. Catatan langsung terlihat oleh Unit dan Tim Linen RS (lewat log).
export const updateComplaintStatus = async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status ? String(req.body.status) : null;
  const note = clean(req.body?.note, 2000);
  if (!status && !note) return res.status(400).json({ message: "Pilih status baru atau isi catatan" });
  if (status && !ADMIN_TARGETS.includes(status)) return res.status(400).json({ message: "Status tidak valid" });
  if (status === "DITOLAK" && !note) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

  try {
    const [rows] = await safeIKMQuery("SELECT id, hospital_id, complaint_number, status FROM tr_complaint WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ message: "Komplain tidak ditemukan" });
    const c = rows[0];
    const actor = await resolveActor(req);
    const actorName = actor.fullName || actor.username || "Admin";

    if (status && status !== c.status) {
      const allowed = ADMIN_TRANSITIONS[c.status] || [];
      if (!allowed.includes(status)) {
        return res.status(409).json({
          message: c.status === "DIAJUKAN"
            ? "Dari status Diajukan, admin hanya bisa menyetujui atau menolak (mewakili Tim Linen RS)"
            : ["SELESAI", "DITOLAK"].includes(c.status)
              ? "Komplain sudah selesai / ditolak dan tidak bisa diubah statusnya"
              : "Perubahan status tidak diizinkan",
        });
      }
      // Admin bertindak atas nama Tim Linen RS: wajib ada alasan agar tercatat
      const onBehalf = c.status === "DIAJUKAN";
      if (onBehalf && !note) {
        return res.status(400).json({ message: "Alasan wajib diisi saat admin menyetujui/menolak mewakili Tim Linen RS" });
      }
      // Guard di UPDATE agar tidak menimpa perubahan yang terjadi bersamaan
      const [upd] = onBehalf
        ? await safeIKMQuery(
            "UPDATE tr_complaint SET status = ?, updated_by = ?, rs_approved_by = ?, rs_approved_at = NOW() WHERE id = ? AND status = ?",
            [status, actorName, `${actorName} (Admin Alora, mewakili Tim Linen RS)`.slice(0, 150), id, c.status])
        : await safeIKMQuery(
            "UPDATE tr_complaint SET status = ?, updated_by = ? WHERE id = ? AND status = ?", [status, actorName, id, c.status]);
      if (!upd.affectedRows) return res.status(409).json({ message: "Status komplain sudah berubah, muat ulang halaman" });
      const action = onBehalf ? (status === "DISETUJUI_RS" ? "APPROVED" : "REJECTED") : "STATUS";
      await safeIKMQuery(
        `INSERT INTO tr_complaint_log (complaint_id, complaint_number, action, from_status, to_status, note, detail, actor_name, actor_username, actor_role)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, c.complaint_number, action, c.status, status, note || null, onBehalf ? JSON.stringify({ on_behalf_of: "rs" }) : null, actorName, actor.username || null, "admin"]);
    } else if (note) {
      await safeIKMQuery(
        `INSERT INTO tr_complaint_log (complaint_id, complaint_number, action, note, actor_name, actor_username, actor_role)
         VALUES (?,?,?,?,?,?,?)`,
        [id, c.complaint_number, "NOTE", note, actorName, actor.username || null, "admin"]);
    } else {
      return res.status(400).json({ message: "Status sama dengan sebelumnya" });
    }

    notifyLinenMonitoring(c.hospital_id, "COMPLAINT", `Komplain ${c.complaint_number} diperbarui admin`);
    res.json({ message: "Komplain diperbarui" });
  } catch (err) { fail(res, "updateComplaintStatus", err); }
};

// ── Master kategori komplain ───────────────────────────────────────────────
export const listCategories = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery("SELECT id, category_name, description, is_active FROM mst_complaint_category ORDER BY category_name");
    res.json({ data: rows });
  } catch (err) { fail(res, "listCategories", err); }
};

export const createCategory = async (req, res) => {
  const name = clean(req.body?.category_name, 100);
  if (!name) return res.status(400).json({ message: "Nama kategori wajib diisi" });
  try {
    const [r] = await safeIKMQuery(
      "INSERT INTO mst_complaint_category (category_name, description) VALUES (?, ?)", [name, clean(req.body?.description, 255) || null]);
    res.status(201).json({ message: "Kategori ditambahkan", id: r.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Nama kategori sudah ada" });
    fail(res, "createCategory", err);
  }
};

export const updateCategory = async (req, res) => {
  const name = clean(req.body?.category_name, 100);
  if (!name) return res.status(400).json({ message: "Nama kategori wajib diisi" });
  try {
    const [r] = await safeIKMQuery(
      "UPDATE mst_complaint_category SET category_name = ?, description = ?, is_active = ? WHERE id = ?",
      [name, clean(req.body?.description, 255) || null, req.body?.is_active === false || req.body?.is_active === 0 ? 0 : 1, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: "Kategori tidak ditemukan" });
    res.json({ message: "Kategori diperbarui" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Nama kategori sudah ada" });
    fail(res, "updateCategory", err);
  }
};

// Jenis komplain di tr_complaint berupa teks bebas (bukan FK), jadi kategori aman dihapus
export const deleteCategory = async (req, res) => {
  try {
    const [r] = await safeIKMQuery("DELETE FROM mst_complaint_category WHERE id = ?", [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: "Kategori tidak ditemukan" });
    res.json({ message: "Kategori dihapus" });
  } catch (err) { fail(res, "deleteCategory", err); }
};
