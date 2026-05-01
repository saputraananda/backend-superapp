import { safeQuery } from "../db/pool.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(__dirname, "..", "assets");
const ASET_PHOTO_DIR = path.join(BASE_DIR, "aset_photos");

// ── Helper: generate kode_aset ──────────────────────────────────────────
async function generateKodeAset() {
  const [[{ maxId }]] = await safeQuery("SELECT COALESCE(MAX(id), 0) AS maxId FROM mst_aset");
  const next = maxId + 1;
  return `AST-${String(next).padStart(5, "0")}`;
}

// ── Helper: get employee from session ───────────────────────────────────
function getSessionEmployee(req) {
  return {
    employeeId: req.session?.employeeId || null,
    userId: req.session?.userId || null,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// MASTER DATA & STATS
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset/master-data ───────────────────────────────────────────────
export const getMasterData = async (_req, res) => {
  try {
    const [companies] = await safeQuery(
      "SELECT company_id, company_name FROM mst_company ORDER BY company_name"
    );
    const [employees] = await safeQuery(
      `SELECT e.employee_id, e.full_name, e.job_level_id, p.position_name 
       FROM mst_employee e 
       LEFT JOIN mst_position p ON e.position_id = p.position_id 
       WHERE e.is_deleted = 0 AND e.exit_date IS NULL ORDER BY e.full_name`
    );
    const [outlets] = await safeQuery(
      "SELECT id, name, full_name FROM mst_outlet ORDER BY name"
    );
    res.json({ companies, employees, outlets });
  } catch (err) {
    console.error("getMasterData error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/stats ─────────────────────────────────────────────────────
export const getStats = async (_req, res) => {
  try {
    const [[{ total }]] = await safeQuery(
      "SELECT COUNT(*) AS total FROM mst_aset WHERE is_deleted = 0"
    );
    const [byKondisi] = await safeQuery(
      "SELECT kondisi, COUNT(*) AS cnt FROM mst_aset WHERE is_deleted = 0 GROUP BY kondisi"
    );
    const [bySubKategori] = await safeQuery(
      "SELECT sub_kategori, COUNT(*) AS cnt FROM mst_aset WHERE is_deleted = 0 GROUP BY sub_kategori"
    );
    const [byApproval] = await safeQuery(
      "SELECT approval_status, COUNT(*) AS cnt FROM mst_aset WHERE is_deleted = 0 GROUP BY approval_status"
    );

    // Flatten approval counts ke flat key supaya frontend bisa akses stats.draft, dll.
    const approvalMap = {};
    byApproval.forEach(r => { approvalMap[r.approval_status] = r.cnt; });

    res.json({
      total,
      byKondisi,
      bySubKategori,
      byApproval,
      draft: approvalMap["draft"] || 0,
      pending_spv: approvalMap["pending_spv"] || 0,
      pending_bod: approvalMap["pending_bod"] || 0,
      approved: approvalMap["approved"] || 0,
      rejected: approvalMap["rejected"] || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// ASET CRUD
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset ───────────────────────────────────────────────────────────
export const getAsets = async (req, res) => {
  try {
    const {
      search = "",
      sub_kategori = "",
      kondisi = "",
      company_id = "",
      approval_status = "",
      outlet_id = "",
      page = 1,
      limit = 20,
    } = req.query;

    let where = "a.is_deleted = 0";
    const params = [];

    if (search) {
      where += " AND (a.kode_aset LIKE ? OR a.nama_aset LIKE ? OR a.brand LIKE ? OR a.no_seri LIKE ?)";
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (sub_kategori) {
      where += " AND a.sub_kategori = ?";
      params.push(sub_kategori);
    }
    if (kondisi) {
      where += " AND a.kondisi = ?";
      params.push(kondisi);
    }
    if (company_id) {
      where += " AND a.company_id = ?";
      params.push(Number(company_id));
    }
    if (approval_status) {
      where += " AND a.approval_status = ?";
      params.push(approval_status);
    }
    if (outlet_id) {
      where += " AND a.outlet_id = ?";
      params.push(Number(outlet_id));
    }

    const offset = (Number(page) - 1) * Number(limit);

    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) AS total FROM mst_aset a WHERE ${where}`,
      params
    );

    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name, sub.full_name AS submitted_by_name,
              o.name AS outlet_name, o.full_name AS outlet_full_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       LEFT JOIN mst_employee sub ON a.submitted_by = sub.employee_id
       LEFT JOIN mst_outlet o ON a.outlet_id = o.id
       WHERE ${where}
       ORDER BY a.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const [photos] = await safeQuery(
        `SELECT * FROM tr_aset_photos WHERE aset_id IN (?) ORDER BY aset_id, created_at`,
        [ids]
      );
      const photoMap = {};
      photos.forEach((p) => {
        if (!photoMap[p.aset_id]) photoMap[p.aset_id] = [];
        photoMap[p.aset_id].push(p);
      });
      rows.forEach((r) => {
        r.photos = photoMap[r.id] || [];
        r.photo_count = r.photos.length;
      });
    }

    res.json({
      asets: rows,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
    });
  } catch (err) {
    console.error("getAsets error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/:id ───────────────────────────────────────────────────────
export const getAsetById = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name, sub.full_name AS submitted_by_name,
              o.name AS outlet_name, o.full_name AS outlet_full_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       LEFT JOIN mst_employee sub ON a.submitted_by = sub.employee_id
       LEFT JOIN mst_outlet o ON a.outlet_id = o.id
       WHERE a.id = ? AND a.is_deleted = 0`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    const [photos] = await safeQuery(
      "SELECT * FROM tr_aset_photos WHERE aset_id = ? ORDER BY created_at",
      [req.params.id]
    );

    // Get approval history
    const [approvals] = await safeQuery(
      `SELECT ap.*, e.full_name AS actor_name 
       FROM tr_aset_approval ap 
       LEFT JOIN mst_employee e ON ap.actor_employee_id = e.employee_id
       WHERE ap.aset_id = ? ORDER BY ap.created_at DESC`,
      [req.params.id]
    );

    res.json({ aset: { ...rows[0], photos, approvals } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── GET /aset/kode/:kode ────────────────────────────────────────────────
export const getAsetByKode = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT a.*, c.company_name, e.full_name AS pic_name, sub.full_name AS submitted_by_name,
              o.name AS outlet_name, o.full_name AS outlet_full_name
       FROM mst_aset a
       LEFT JOIN mst_company c ON a.company_id = c.company_id
       LEFT JOIN mst_employee e ON a.pic_employee_id = e.employee_id
       LEFT JOIN mst_employee sub ON a.submitted_by = sub.employee_id
       LEFT JOIN mst_outlet o ON a.outlet_id = o.id
       WHERE a.kode_aset = ? AND a.is_deleted = 0`,
      [req.params.kode]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset dengan kode tersebut tidak ditemukan" });

    const [photos] = await safeQuery(
      "SELECT * FROM tr_aset_photos WHERE aset_id = ? ORDER BY created_at",
      [rows[0].id]
    );

    const [approvals] = await safeQuery(
      `SELECT ap.*, e.full_name AS actor_name 
       FROM tr_aset_approval ap 
       LEFT JOIN mst_employee e ON ap.actor_employee_id = e.employee_id
       WHERE ap.aset_id = ? ORDER BY ap.created_at DESC`,
      [rows[0].id]
    );

    res.json({ aset: { ...rows[0], photos, approvals } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset — create (status = draft) ────────────────────────────────
export const createAset = async (req, res) => {
  const {
    kode_aset, nama_aset, company_id, sub_kategori, brand, model,
    no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan,
    pic_employee_id, kondisi, is_active, outlet_id,
  } = req.body;

  if (!nama_aset?.trim()) return res.status(400).json({ message: "Nama aset wajib diisi" });
  if (!sub_kategori) return res.status(400).json({ message: "Sub kategori wajib dipilih" });

  const { employeeId } = getSessionEmployee(req);

  try {
    const finalKode = kode_aset?.trim() || (await generateKodeAset());

    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE kode_aset = ?", [finalKode]);
    if (exist.length > 0) return res.status(409).json({ message: "Kode aset sudah digunakan" });

    // outlet_id hanya berlaku untuk company_id = 5
    const effectiveOutletId = Number(company_id) === 5 ? (outlet_id || null) : null;

    const [result] = await safeQuery(
      `INSERT INTO mst_aset (kode_aset, nama_aset, company_id, sub_kategori, brand, model,
        no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan, pic_employee_id, kondisi, 
        is_active, approval_status, submitted_by, outlet_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [
        finalKode, nama_aset, company_id || null, sub_kategori, brand || null,
        model || null, no_seri || null, lokasi_nama || null,
        lokasi_lat || null, lokasi_lng || null, jumlah || 1,
        satuan || "Unit", pic_employee_id || null, kondisi || "Baik",
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
        employeeId, effectiveOutletId,
      ]
    );

    res.status(201).json({
      message: "Aset berhasil ditambahkan (Draft)",
      id: result.insertId,
      kode_aset: finalKode,
    });
  } catch (err) {
    console.error("createAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /aset/:id — update ──────────────────────────────────────────────
export const updateAset = async (req, res) => {
  const { id } = req.params;
  const {
    kode_aset, nama_aset, company_id, sub_kategori, brand, model,
    no_seri, lokasi_nama, lokasi_lat, lokasi_lng, jumlah, satuan,
    pic_employee_id, kondisi, is_active, outlet_id,
  } = req.body;

  if (!nama_aset?.trim()) return res.status(400).json({ message: "Nama aset wajib diisi" });

  try {
    const [exist] = await safeQuery("SELECT id, approval_status FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    if (kode_aset) {
      const [dup] = await safeQuery("SELECT id FROM mst_aset WHERE kode_aset = ? AND id != ?", [kode_aset, id]);
      if (dup.length > 0) return res.status(409).json({ message: "Kode aset sudah digunakan" });
    }

    // outlet_id hanya berlaku untuk company_id = 5
    const effectiveOutletId = Number(company_id) === 5 ? (outlet_id || null) : null;

    await safeQuery(
      `UPDATE mst_aset SET
        kode_aset=?, nama_aset=?, company_id=?, sub_kategori=?, brand=?, model=?,
        no_seri=?, lokasi_nama=?, lokasi_lat=?, lokasi_lng=?, jumlah=?, satuan=?,
        pic_employee_id=?, kondisi=?, is_active=?, outlet_id=?, updated_at=NOW()
       WHERE id=?`,
      [
        kode_aset, nama_aset, company_id || null, sub_kategori, brand || null,
        model || null, no_seri || null, lokasi_nama || null,
        lokasi_lat || null, lokasi_lng || null, jumlah || 1,
        satuan || "Unit", pic_employee_id || null, kondisi || "Baik",
        is_active !== undefined ? (is_active ? 1 : 0) : 1, effectiveOutletId, id,
      ]
    );

    res.json({ message: "Aset berhasil diperbarui" });
  } catch (err) {
    console.error("updateAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /aset/:id — soft delete ──────────────────────────────────────
export const deleteAset = async (req, res) => {
  try {
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [req.params.id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery("UPDATE mst_aset SET is_deleted = 1, updated_at = NOW() WHERE id = ?", [req.params.id]);
    res.json({ message: "Aset berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// APPROVAL FLOW
// ══════════════════════════════════════════════════════════════════════════

// ── POST /aset/:id/submit — Staff submit draft → pending_spv ────────────
export const submitAset = async (req, res) => {
  const { id } = req.params;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  try {
    const [empRows] = await safeQuery(
      "SELECT job_level_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0",
      [employeeId]
    );
    if (empRows.length === 0 || Number(empRows[0].job_level_id) < 4) {
      return res.status(403).json({ message: "Hanya Staff yang dapat mengajukan approval" });
    }
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }

  try {
    const [rows] = await safeQuery(
      "SELECT id, approval_status FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });
    if (rows[0].approval_status !== "draft" && rows[0].approval_status !== "rejected") {
      return res.status(400).json({ message: "Aset hanya bisa disubmit dari status Draft atau Rejected" });
    }

    await safeQuery(
      "UPDATE mst_aset SET approval_status = 'pending_spv', submitted_by = ?, submitted_at = NOW(), updated_at = NOW() WHERE id = ?",
      [employeeId, id]
    );

    await safeQuery(
      "INSERT INTO tr_aset_approval (aset_id, action, actor_employee_id, remarks) VALUES (?, 'submit', ?, ?)",
      [id, employeeId, req.body.remarks || null]
    );

    res.json({ message: "Aset berhasil disubmit untuk approval Supervisor" });
  } catch (err) {
    console.error("submitAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/approve-spv — Supervisor approve → pending_bod ──────
export const approveSpv = async (req, res) => {
  const { id } = req.params;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  try {
    // Verify manager/supervisor role (job_level_id <= 3)
    const [emp] = await safeQuery("SELECT job_level_id FROM mst_employee WHERE employee_id = ?", [employeeId]);
    if (emp.length === 0 || Number(emp[0].job_level_id) > 3) {
      return res.status(403).json({ message: "Hanya Manager/Supervisor atau Direktur yang dapat menyetujui" });
    }

    const [rows] = await safeQuery(
      "SELECT id, approval_status FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });
    if (rows[0].approval_status !== "pending_spv") {
      return res.status(400).json({ message: "Aset tidak dalam status Pending Supervisor" });
    }

    await safeQuery(
      "UPDATE mst_aset SET approval_status = 'pending_bod', updated_at = NOW() WHERE id = ?", [id]
    );

    await safeQuery(
      "INSERT INTO tr_aset_approval (aset_id, action, actor_employee_id, remarks) VALUES (?, 'approve_spv', ?, ?)",
      [id, employeeId, req.body.remarks || null]
    );

    res.json({ message: "Aset disetujui Supervisor, menunggu approval Direktur" });
  } catch (err) {
    console.error("approveSpv error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/approve-bod — BoD approve → approved ────────────────
export const approveBod = async (req, res) => {
  const { id } = req.params;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  try {
    // Verify BoD role (job_level_id = 1)
    const [emp] = await safeQuery("SELECT job_level_id FROM mst_employee WHERE employee_id = ?", [employeeId]);
    if (emp.length === 0 || Number(emp[0].job_level_id) !== 1) {
      return res.status(403).json({ message: "Hanya Direktur yang dapat menyetujui final" });
    }

    const [rows] = await safeQuery(
      "SELECT id, approval_status FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });
    if (rows[0].approval_status !== "pending_bod") {
      return res.status(400).json({ message: "Aset tidak dalam status Pending Direktur" });
    }

    await safeQuery(
      "UPDATE mst_aset SET approval_status = 'approved', updated_at = NOW() WHERE id = ?", [id]
    );

    await safeQuery(
      "INSERT INTO tr_aset_approval (aset_id, action, actor_employee_id, remarks) VALUES (?, 'approve_bod', ?, ?)",
      [id, employeeId, req.body.remarks || null]
    );

    res.json({ message: "Aset telah disetujui dan resmi terdata" });
  } catch (err) {
    console.error("approveBod error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/reject — Supervisor/BoD reject → rejected ───────────
export const rejectAset = async (req, res) => {
  const { id } = req.params;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  try {
    const [emp] = await safeQuery("SELECT job_level_id FROM mst_employee WHERE employee_id = ?", [employeeId]);
    if (emp.length === 0 || Number(emp[0].job_level_id) > 3) {
      return res.status(403).json({ message: "Hanya Manager/Supervisor atau Direktur yang dapat menolak" });
    }

    const [rows] = await safeQuery(
      "SELECT id, approval_status FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });
    if (!["pending_spv", "pending_bod"].includes(rows[0].approval_status)) {
      return res.status(400).json({ message: "Aset tidak dalam status pending approval" });
    }

    const action = rows[0].approval_status === "pending_spv" ? "reject_spv" : "reject_bod";

    await safeQuery(
      "UPDATE mst_aset SET approval_status = 'rejected', updated_at = NOW() WHERE id = ?", [id]
    );

    await safeQuery(
      "INSERT INTO tr_aset_approval (aset_id, action, actor_employee_id, remarks) VALUES (?, ?, ?, ?)",
      [id, action, employeeId, req.body.remarks || "Ditolak tanpa keterangan"]
    );

    res.json({ message: "Aset ditolak" });
  } catch (err) {
    console.error("rejectAset error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// MUTASI
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset/:id/mutasi ────────────────────────────────────────────────
export const getMutasi = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT m.*, 
              pl.full_name AS pic_lama_name, pb.full_name AS pic_baru_name,
              cr.full_name AS created_by_name
       FROM tr_aset_mutasi m
       LEFT JOIN mst_employee pl ON m.pic_lama_id = pl.employee_id
       LEFT JOIN mst_employee pb ON m.pic_baru_id = pb.employee_id
       LEFT JOIN mst_employee cr ON m.created_by = cr.employee_id
       WHERE m.aset_id = ? ORDER BY m.created_at DESC`,
      [req.params.id]
    );
    res.json({ mutasi: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/mutasi ───────────────────────────────────────────────
export const createMutasi = async (req, res) => {
  const { id } = req.params;
  const { tipe, lokasi_lama, lokasi_baru, pic_lama_id, pic_baru_id, alasan, tanggal_mutasi } = req.body;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  try {
    const [aset] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (aset.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery(
      `INSERT INTO tr_aset_mutasi (aset_id, tipe, lokasi_lama, lokasi_baru, pic_lama_id, pic_baru_id, alasan, tanggal_mutasi, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tipe, lokasi_lama || null, lokasi_baru || null, pic_lama_id || null, pic_baru_id || null, alasan || null, tanggal_mutasi, employeeId]
    );

    // Auto-update mst_aset lokasi/pic
    const updates = [];
    const updateParams = [];
    if (lokasi_baru) { updates.push("lokasi_nama = ?"); updateParams.push(lokasi_baru); }
    if (pic_baru_id) { updates.push("pic_employee_id = ?"); updateParams.push(pic_baru_id); }
    if (updates.length > 0) {
      await safeQuery(`UPDATE mst_aset SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ?`, [...updateParams, id]);
    }

    res.status(201).json({ message: "Mutasi aset berhasil dicatat" });
  } catch (err) {
    console.error("createMutasi error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset/:id/maintenance ───────────────────────────────────────────
export const getMaintenance = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT mt.*, cr.full_name AS created_by_name
       FROM tr_aset_maintenance mt
       LEFT JOIN mst_employee cr ON mt.created_by = cr.employee_id
       WHERE mt.aset_id = ? ORDER BY mt.created_at DESC`,
      [req.params.id]
    );
    res.json({ maintenance: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/maintenance ──────────────────────────────────────────
export const createMaintenance = async (req, res) => {
  const { id } = req.params;
  const { tipe, deskripsi, tanggal_mulai, tanggal_selesai, biaya, vendor, status, catatan } = req.body;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  if (!deskripsi?.trim()) return res.status(400).json({ message: "Deskripsi wajib diisi" });
  if (!tanggal_mulai) return res.status(400).json({ message: "Tanggal mulai wajib diisi" });

  try {
    const [aset] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (aset.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery(
      `INSERT INTO tr_aset_maintenance (aset_id, tipe, deskripsi, tanggal_mulai, tanggal_selesai, biaya, vendor, status, catatan, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, tipe || "perbaikan", deskripsi, tanggal_mulai, tanggal_selesai || null, biaya || 0, vendor || null, status || "dijadwalkan", catatan || null, employeeId]
    );

    res.status(201).json({ message: "Maintenance berhasil dicatat" });
  } catch (err) {
    console.error("createMaintenance error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /aset/maintenance/:maintenanceId ────────────────────────────────
export const updateMaintenance = async (req, res) => {
  const { maintenanceId } = req.params;
  const { tipe, deskripsi, tanggal_mulai, tanggal_selesai, biaya, vendor, status, catatan } = req.body;

  try {
    await safeQuery(
      `UPDATE tr_aset_maintenance SET tipe=?, deskripsi=?, tanggal_mulai=?, tanggal_selesai=?, biaya=?, vendor=?, status=?, catatan=?, updated_at=NOW()
       WHERE id=?`,
      [tipe, deskripsi, tanggal_mulai, tanggal_selesai || null, biaya || 0, vendor || null, status, catatan || null, maintenanceId]
    );
    res.json({ message: "Maintenance berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PEMINJAMAN
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset/:id/peminjaman ────────────────────────────────────────────
export const getPeminjaman = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT pj.*, pe.full_name AS peminjam_name, cr.full_name AS created_by_name
       FROM tr_aset_peminjaman pj
       LEFT JOIN mst_employee pe ON pj.peminjam_employee_id = pe.employee_id
       LEFT JOIN mst_employee cr ON pj.created_by = cr.employee_id
       WHERE pj.aset_id = ? ORDER BY pj.created_at DESC`,
      [req.params.id]
    );
    res.json({ peminjaman: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/peminjaman ───────────────────────────────────────────
export const createPeminjaman = async (req, res) => {
  const { id } = req.params;
  const { peminjam_employee_id, tanggal_pinjam, tanggal_kembali_rencana, tujuan, catatan } = req.body;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  if (!peminjam_employee_id) return res.status(400).json({ message: "Peminjam wajib dipilih" });
  if (!tanggal_pinjam) return res.status(400).json({ message: "Tanggal pinjam wajib diisi" });

  try {
    const [aset] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (aset.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery(
      `INSERT INTO tr_aset_peminjaman (aset_id, peminjam_employee_id, tanggal_pinjam, tanggal_kembali_rencana, tujuan, catatan, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, peminjam_employee_id, tanggal_pinjam, tanggal_kembali_rencana || null, tujuan || null, catatan || null, employeeId]
    );

    res.status(201).json({ message: "Peminjaman berhasil dicatat" });
  } catch (err) {
    console.error("createPeminjaman error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /aset/peminjaman/:peminjamanId ──────────────────────────────────
export const updatePeminjaman = async (req, res) => {
  const { peminjamanId } = req.params;
  const { tanggal_kembali_aktual, status, catatan } = req.body;

  try {
    await safeQuery(
      `UPDATE tr_aset_peminjaman SET tanggal_kembali_aktual=?, status=?, catatan=?, updated_at=NOW() WHERE id=?`,
      [tanggal_kembali_aktual || null, status, catatan || null, peminjamanId]
    );
    res.json({ message: "Peminjaman berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PENGHAPUSAN / DISPOSAL
// ══════════════════════════════════════════════════════════════════════════

// ── GET /aset/:id/penghapusan ───────────────────────────────────────────
export const getPenghapusan = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT pg.*, cr.full_name AS created_by_name, ap.full_name AS approved_by_name
       FROM tr_aset_penghapusan pg
       LEFT JOIN mst_employee cr ON pg.created_by = cr.employee_id
       LEFT JOIN mst_employee ap ON pg.approved_by = ap.employee_id
       WHERE pg.aset_id = ? ORDER BY pg.created_at DESC`,
      [req.params.id]
    );
    res.json({ penghapusan: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── POST /aset/:id/penghapusan ──────────────────────────────────────────
export const createPenghapusan = async (req, res) => {
  const { id } = req.params;
  const { tipe, alasan, tanggal_penghapusan, nilai_sisa } = req.body;
  const { employeeId } = getSessionEmployee(req);
  if (!employeeId) return res.status(401).json({ message: "Session employee tidak ditemukan" });

  if (!alasan?.trim()) return res.status(400).json({ message: "Alasan wajib diisi" });
  if (!tanggal_penghapusan) return res.status(400).json({ message: "Tanggal penghapusan wajib diisi" });

  try {
    const [aset] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (aset.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    await safeQuery(
      `INSERT INTO tr_aset_penghapusan (aset_id, tipe, alasan, tanggal_penghapusan, nilai_sisa, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, tipe || "disposal", alasan, tanggal_penghapusan, nilai_sisa || 0, employeeId]
    );

    // Set aset inactive
    await safeQuery("UPDATE mst_aset SET is_active = 0, updated_at = NOW() WHERE id = ?", [id]);

    res.status(201).json({ message: "Penghapusan aset berhasil dicatat" });
  } catch (err) {
    console.error("createPenghapusan error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// PHOTOS (tetap sama)
// ══════════════════════════════════════════════════════════════════════════

export const uploadPhotos = async (req, res) => {
  const { id } = req.params;

  try {
    const [exist] = await safeQuery("SELECT id FROM mst_aset WHERE id = ? AND is_deleted = 0", [id]);
    if (exist.length === 0) return res.status(404).json({ message: "Aset tidak ditemukan" });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "Tidak ada file yang diupload" });
    }

    const captions = req.body.captions || [];
    const values = req.files.map((f, i) => [
      id,
      `aset_photos/${f.filename}`,
      f.originalname,
      Array.isArray(captions) ? captions[i] || null : captions || null,
    ]);

    for (const v of values) {
      await safeQuery(
        "INSERT INTO tr_aset_photos (aset_id, photo_path, photo_name, caption) VALUES (?, ?, ?, ?)",
        v
      );
    }

    const [photos] = await safeQuery(
      `SELECT * FROM tr_aset_photos WHERE aset_id = ? ORDER BY created_at`,
      [id]
    );

    res.status(201).json({ message: "Foto berhasil diupload", photos });
  } catch (err) {
    console.error("uploadPhotos error:", err);
    res.status(500).json({ message: err.message });
  }
};

export const deletePhoto = async (req, res) => {
  try {
    const [rows] = await safeQuery("SELECT * FROM tr_aset_photos WHERE id = ?", [req.params.photoId]);
    if (rows.length === 0) return res.status(404).json({ message: "Foto tidak ditemukan" });

    const photo = rows[0];
    const abs = path.join(BASE_DIR, photo.photo_path);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) { }
    }

    await safeQuery("DELETE FROM tr_aset_photos WHERE id = ?", [req.params.photoId]);
    res.json({ message: "Foto berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};