// ════════════════════════════════════════════════════════════════════════════
// ALORA DOCUMENT MANAGEMENT SYSTEM — Controller
//
// Tables:
//   mst_document               → Master dokumen perusahaan
//                                (entitas: company_id/outlet_id, NULL = custom di kolom entity)
//   mst_document_number        → Nomor-nomor dokumen (1 dokumen bisa banyak nomor, unik global)
//   tr_document_transaction    → Transaksi peminjaman & pengembalian dokumen
//
// Status mst_document: active | inactive | expired | archived
// Status tr_document_transaction: borrowed | returned | overdue | lost
// ════════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
  ? (process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/")
  : path.join(__dirname, "..", "assets");

// ── helpers ─────────────────────────────────────────────────────────────────
const safeQuery = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

// Automatically mark documents as expired if they past their expiry_date
const checkAndUpdateExpiredDocuments = async () => {
  try {
    await pool.query(
      `UPDATE mst_document 
       SET status = 'expired' 
       WHERE is_deleted = 0 
         AND status = 'active'
         AND expiry_date IS NOT NULL 
         AND expiry_date < CURDATE()`
    );
  } catch (err) {
    console.error("[checkAndUpdateExpiredDocuments]", err);
  }
};

const getEmployeeId = (req) =>
  req.session?.employeeId ?? req.session?.employee_id ?? null;

const sanitize = (str) => {
  if (str == null) return null;
  return String(str)
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
};

// Company yang punya turunan outlet (mst_outlet)
const OUTLET_COMPANY_ID = 5;

// Semua nomor dokumen digabung, urut sesuai input
const numbersSql = (alias) =>
  `(SELECT GROUP_CONCAT(dn.document_number ORDER BY dn.sort_order, dn.id SEPARATOR ', ')
    FROM mst_document_number dn WHERE dn.document_id = ${alias}.id)`;

// Parse & validasi body.document_numbers (JSON: [{ number, label }])
const parseDocumentNumbers = (raw) => {
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { list = null; }
  if (!Array.isArray(list)) return { error: "Format nomor dokumen tidak valid" };

  const numbers = list
    .map(n => ({ number: sanitize(n?.number), label: sanitize(n?.label) || null }))
    .filter(n => n.number);
  if (!numbers.length) return { error: "Minimal satu nomor dokumen wajib diisi" };
  if (numbers.some(n => n.number.length > 100)) return { error: "Nomor dokumen maksimal 100 karakter" };

  const seen = new Set();
  for (const n of numbers) {
    const key = n.number.toLowerCase();
    if (seen.has(key)) return { error: `Nomor "${n.number}" diisi lebih dari sekali` };
    seen.add(key);
  }
  return { numbers };
};

// Pastikan nomor belum dipakai dokumen lain
const findUsedNumber = async (numbers, excludeDocId = null) => {
  const rows = await safeQuery(
    `SELECT dn.document_number, d.document_name
     FROM mst_document_number dn
     JOIN mst_document d ON d.id = dn.document_id
     WHERE dn.document_number IN (?) ${excludeDocId ? "AND dn.document_id <> ?" : ""}
     LIMIT 1`,
    excludeDocId ? [numbers.map(n => n.number), excludeDocId] : [numbers.map(n => n.number)]
  );
  return rows[0] || null;
};

const saveDocumentNumbers = async (conn, documentId, numbers) => {
  await conn.query(`DELETE FROM mst_document_number WHERE document_id = ?`, [documentId]);
  await conn.query(
    `INSERT INTO mst_document_number (document_id, document_number, label, sort_order) VALUES ?`,
    [numbers.map((n, i) => [documentId, n.number, n.label, i])]
  );
};

// Resolve entitas: company_id/outlet_id → nama, atau custom (company_id NULL)
const resolveEntity = async ({ company_id, outlet_id, entity }) => {
  const companyId = company_id ? Number(company_id) : null;
  if (!companyId) {
    const custom = sanitize(entity);
    if (!custom) return { error: "Entitas wajib diisi" };
    return { companyId: null, outletId: null, entity: custom };
  }

  const comp = await safeQuery(`SELECT company_name FROM mst_company WHERE company_id = ?`, [companyId]);
  if (!comp.length) return { error: "Entitas (company) tidak ditemukan" };

  const outletId = companyId === OUTLET_COMPANY_ID && outlet_id ? Number(outlet_id) : null;
  if (outletId) {
    const out = await safeQuery(`SELECT full_name FROM mst_outlet WHERE id = ?`, [outletId]);
    if (!out.length) return { error: "Outlet tidak ditemukan" };
    return { companyId, outletId, entity: out[0].full_name };
  }
  return { companyId, outletId: null, entity: comp[0].company_name };
};

// Bucket sisa masa berlaku (hari) — dipakai filter daftar & dashboard supaya angkanya selalu sama
const DD = "DATEDIFF(d.expiry_date, CURDATE())";
const EXPIRY_BUCKET_SQL = {
  expired: `d.expiry_date IS NOT NULL AND ${DD} < 0`,
  "30":    `d.expiry_date IS NOT NULL AND ${DD} BETWEEN 0 AND 30`,
  "60":    `d.expiry_date IS NOT NULL AND ${DD} BETWEEN 31 AND 60`,
  "90":    `d.expiry_date IS NOT NULL AND ${DD} BETWEEN 61 AND 90`,
  safe:    `d.expiry_date IS NOT NULL AND ${DD} > 90`,
  none:    `d.expiry_date IS NULL`,
  // gabungan — dipakai klik grafik/daftar di dashboard
  soon:    `d.expiry_date IS NOT NULL AND ${DD} BETWEEN 0 AND 90`,
  risk:    `d.expiry_date IS NOT NULL AND ${DD} <= 90`,
  r60:     `d.expiry_date IS NOT NULL AND ${DD} <= 60`,
  ok:      `(d.expiry_date IS NULL OR ${DD} > 90)`,
};

// Generate transaction code: TRX-YYYYMMDD-001
const generateTransactionCode = async () => {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const prefix = `TRX-${dateStr}-`;
  const rows = await safeQuery(
    `SELECT transaction_code FROM tr_document_transaction
     WHERE transaction_code LIKE ? ORDER BY id DESC LIMIT 1`,
    [`${prefix}%`]
  );
  let seq = 1;
  if (rows.length > 0) {
    const last = rows[0].transaction_code.split("-").pop();
    seq = (parseInt(last, 10) || 0) + 1;
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
};

// ════════════════════════════════════════════════════════════════════════════
// MASTER DOCUMENT — CRUD
// ════════════════════════════════════════════════════════════════════════════

// GET /doc-alora/documents — List all documents
export const listDocuments = async (req, res) => {
  try {
    await checkAndUpdateExpiredDocuments();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || "";
    const status = req.query.status?.trim() || "";
    const departmentId = req.query.department_id ? Number(req.query.department_id) : null;
    const expiringSoon = req.query.expiring_soon === "true";
    const overdue = req.query.overdue === "true";
    const companyFilter = req.query.company_id?.trim() || ""; // id | "custom"
    const outletId = req.query.outlet_id ? Number(req.query.outlet_id) : null;
    const picId = req.query.pic_id ? Number(req.query.pic_id) : null;

    const conditions = ["d.is_deleted = 0"];
    const params = [];

    if (search) {
      conditions.push(`(d.document_name LIKE ? OR d.entity LIKE ?
        OR EXISTS (SELECT 1 FROM mst_document_number sn WHERE sn.document_id = d.id AND sn.document_number LIKE ?))`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (companyFilter === "custom") {
      conditions.push("d.company_id IS NULL");
    } else if (companyFilter) {
      conditions.push("d.company_id = ?");
      params.push(Number(companyFilter));
    }
    if (outletId) {
      conditions.push("d.outlet_id = ?");
      params.push(outletId);
    }
    if (picId) {
      conditions.push("d.pic_id = ?");
      params.push(picId);
    }
    // Filter sisa masa berlaku (selaras dengan bucket dashboard)
    const expiryClause = EXPIRY_BUCKET_SQL[req.query.expiry];
    if (expiryClause) conditions.push(`d.status IN ('active','expired') AND ${expiryClause}`);
    if (status) {
      conditions.push("d.status = ?");
      params.push(status);
    }
    if (departmentId) {
      conditions.push("d.department_id = ?");
      params.push(departmentId);
    }
    if (expiringSoon) {
      conditions.push("d.status = 'active' AND d.expiry_date IS NOT NULL AND d.expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)");
    }
    if (overdue) {
      conditions.push("d.expiry_date IS NOT NULL AND d.expiry_date < CURDATE()");
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    // Sorting: hanya kolom whitelist yang boleh dipakai (hindari SQL injection lewat query string)
    const SORT_COLUMNS = {
      document_name:  "d.document_name",
      entity:         "COALESCE(ec.company_name, d.entity)",
      pic_name:       "e.full_name",
      effective_date: "d.effective_date",
      expiry_date:    "d.expiry_date",
      status:         "d.status",
    };
    const sortCol = SORT_COLUMNS[req.query.sort_by];
    const sortDir = String(req.query.sort_dir).toLowerCase() === "asc" ? "ASC" : "DESC";
    const orderBy = sortCol ? `${sortCol} ${sortDir}, d.id DESC` : "d.created_at DESC";

    const countRows = await safeQuery(
      `SELECT COUNT(*) AS total FROM mst_document d ${where}`,
      params
    );
    const total = Number(countRows[0].total);

    const data = await safeQuery(
      `SELECT d.*,
              ${numbersSql("d")} AS document_numbers,
              (SELECT GROUP_CONCAT(
                        CONCAT(dl.document_number, IF(dl.label IS NULL OR dl.label = '', '', CONCAT(' (', dl.label, ')')))
                        ORDER BY dl.sort_order, dl.id SEPARATOR '\\n')
               FROM mst_document_number dl WHERE dl.document_id = d.id) AS document_numbers_detail,
              ec.company_name AS entity_company_name,
              eo.name AS entity_outlet_name,
              e.full_name AS pic_name,
              dept.department_name,
              c.company_name AS archive_location_name,
              (SELECT COUNT(*) FROM mst_document_attachment a WHERE a.document_id = d.id AND a.is_deleted = 0) AS attachment_count
       FROM mst_document d
       LEFT JOIN mst_company ec ON ec.company_id = d.company_id
       LEFT JOIN mst_outlet eo ON eo.id = d.outlet_id
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       LEFT JOIN mst_company c ON c.company_id = d.archive_location
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data, total, page, limit });
  } catch (err) {
    console.error("[listDocuments]", err);
    res.status(500).json({ message: "Gagal memuat data dokumen" });
  }
};

// GET /doc-alora/documents/:id — Detail document
export const getDocument = async (req, res) => {
  try {
    await checkAndUpdateExpiredDocuments();
    const { id } = req.params;
    const rows = await safeQuery(
      `SELECT d.*,
              ec.company_name AS entity_company_name,
              eo.name AS entity_outlet_name,
              e.full_name AS pic_name,
              dept.department_name,
              c.company_name AS archive_location_name
       FROM mst_document d
       LEFT JOIN mst_company ec ON ec.company_id = d.company_id
       LEFT JOIN mst_outlet eo ON eo.id = d.outlet_id
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       LEFT JOIN mst_company c ON c.company_id = d.archive_location
       WHERE d.id = ? AND d.is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Dokumen tidak ditemukan" });

    const attachments = await safeQuery(
      `SELECT id, file_path, original_name, mime_type, file_size_kb, uploaded_at
       FROM mst_document_attachment
       WHERE document_id = ? AND is_deleted = 0
       ORDER BY uploaded_at ASC`,
      [id]
    );

    const numbers = await safeQuery(
      `SELECT id, document_number, label FROM mst_document_number
       WHERE document_id = ? ORDER BY sort_order, id`,
      [id]
    );

    res.json({ data: rows[0], attachments, numbers });
  } catch (err) {
    console.error("[getDocument]", err);
    res.status(500).json({ message: "Gagal memuat detail dokumen" });
  }
};

// POST /doc-alora/documents — Create document
export const createDocument = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const {
      document_name, document_numbers, effective_date, expiry_date,
      validity_period, status, pic_id, department_id, archive_location, notes
    } = req.body;

    if (!document_name || !effective_date || !pic_id || !department_id) {
      return res.status(400).json({ message: "Field wajib belum lengkapi" });
    }

    const { numbers, error: numError } = parseDocumentNumbers(document_numbers);
    if (numError) return res.status(400).json({ message: numError });
    const ent = await resolveEntity(req.body);
    if (ent.error) return res.status(400).json({ message: ent.error });

    const used = await findUsedNumber(numbers);
    if (used) {
      return res.status(400).json({ message: `Nomor "${used.document_number}" sudah dipakai di dokumen "${used.document_name}"` });
    }

    let documentId;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO mst_document
          (document_name, document_number, entity, company_id, outlet_id, effective_date, expiry_date,
           validity_period, status, pic_id, department_id, archive_location,
           notes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sanitize(document_name), numbers[0].number, ent.entity, ent.companyId, ent.outletId,
          effective_date, expiry_date || null,
          validity_period ? Number(validity_period) : null,
          status || "active", Number(pic_id), Number(department_id),
          archive_location ? Number(archive_location) : null,
          sanitize(notes), employeeId
        ]
      );
      documentId = result.insertId;
      await saveDocumentNumbers(conn, documentId, numbers);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Multiple attachment upload (optional)
    const files = req.files || [];
    for (const file of files) {
      await safeQuery(
        `INSERT INTO mst_document_attachment
          (document_id, file_path, original_name, mime_type, file_size_kb, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          documentId, `document_alora/${file.filename}`, file.originalname,
          file.mimetype, Math.round(file.size / 1024), employeeId
        ]
      );
    }

    res.status(201).json({ message: "Dokumen berhasil ditambahkan", id: documentId });
  } catch (err) {
    console.error("[createDocument]", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Nomor dokumen sudah terdaftar" });
    }
    res.status(500).json({ message: "Gagal menambahkan dokumen" });
  }
};

// PUT /doc-alora/documents/:id — Update document
export const updateDocument = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const existing = await safeQuery(
      `SELECT * FROM mst_document WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Dokumen tidak ditemukan" });

    const {
      document_name, document_numbers, effective_date, expiry_date,
      validity_period, status, pic_id, department_id, archive_location, notes
    } = req.body;

    if (!document_name || !effective_date || !pic_id || !department_id) {
      return res.status(400).json({ message: "Field wajib belum lengkapi" });
    }

    const { numbers, error: numError } = parseDocumentNumbers(document_numbers);
    if (numError) return res.status(400).json({ message: numError });
    const ent = await resolveEntity(req.body);
    if (ent.error) return res.status(400).json({ message: ent.error });

    const used = await findUsedNumber(numbers, Number(id));
    if (used) {
      return res.status(400).json({ message: `Nomor "${used.document_number}" sudah dipakai di dokumen "${used.document_name}"` });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE mst_document SET
          document_name = ?, document_number = ?, entity = ?, company_id = ?, outlet_id = ?,
          effective_date = ?, expiry_date = ?, validity_period = ?,
          status = ?, pic_id = ?, department_id = ?, archive_location = ?,
          notes = ?, updated_by = ?
         WHERE id = ?`,
        [
          sanitize(document_name), numbers[0].number, ent.entity, ent.companyId, ent.outletId,
          effective_date, expiry_date || null,
          validity_period ? Number(validity_period) : null,
          status || existing[0].status, Number(pic_id), Number(department_id),
          archive_location ? Number(archive_location) : null,
          sanitize(notes), employeeId, id
        ]
      );
      await saveDocumentNumbers(conn, id, numbers);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Tambahkan lampiran baru (append, tidak replace)
    const files = req.files || [];
    for (const file of files) {
      await safeQuery(
        `INSERT INTO mst_document_attachment
          (document_id, file_path, original_name, mime_type, file_size_kb, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          id, `document_alora/${file.filename}`, file.originalname,
          file.mimetype, Math.round(file.size / 1024), employeeId
        ]
      );
    }

    res.json({ message: "Dokumen berhasil diperbarui" });
  } catch (err) {
    console.error("[updateDocument]", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: "Nomor dokumen sudah terdaftar" });
    }
    res.status(500).json({ message: "Gagal memperbarui dokumen" });
  }
};

// DELETE /doc-alora/attachments/:id — Hapus satu lampiran
export const deleteAttachment = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const rows = await safeQuery(
      `SELECT * FROM mst_document_attachment WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Lampiran tidak ditemukan" });

    // Hapus file fisik
    const filePath = path.join(ASSETS_BASE, rows[0].file_path);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.warn("Gagal hapus file:", e.message); }
    }

    await safeQuery(`DELETE FROM mst_document_attachment WHERE id = ?`, [id]);

    res.json({ message: "Lampiran berhasil dihapus" });
  } catch (err) {
    console.error("[deleteAttachment]", err);
    res.status(500).json({ message: "Gagal menghapus lampiran" });
  }
};

// DELETE /doc-alora/documents/:id — Soft delete
export const deleteDocument = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const existing = await safeQuery(
      `SELECT * FROM mst_document WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Dokumen tidak ditemukan" });

    await safeQuery(
      `UPDATE mst_document SET is_deleted = 1, updated_by = ? WHERE id = ?`,
      [employeeId, id]
    );
    // Lepas nomor agar bisa dipakai lagi (nomor pertama tetap tercatat di mst_document)
    await safeQuery(`DELETE FROM mst_document_number WHERE document_id = ?`, [id]);

    res.json({ message: "Dokumen berhasil dihapus" });
  } catch (err) {
    console.error("[deleteDocument]", err);
    res.status(500).json({ message: "Gagal menghapus dokumen" });
  }
};

// GET /doc-alora/dashboard — Dashboard summary
export const getDashboard = async (req, res) => {
  try {
    await checkAndUpdateExpiredDocuments();
    const [statusCount] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM mst_document WHERE is_deleted = 0 GROUP BY status`
    );

    const [expiringSoon] = await pool.query(
      `SELECT COUNT(*) AS count FROM mst_document 
       WHERE is_deleted = 0 AND status = 'active'
       AND expiry_date IS NOT NULL
       AND expiry_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 30 DAY)`
    );

    const [recentDocs] = await pool.query(
      `SELECT d.*, e.full_name AS pic_name, dept.department_name
       FROM mst_document d
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       WHERE d.is_deleted = 0
       ORDER BY d.created_at DESC LIMIT 5`
    );

    const [activeBorrows] = await pool.query(
      `SELECT COUNT(*) AS count FROM tr_document_transaction 
       WHERE is_deleted = 0 AND status = 'borrowed'`
    );

    const [overdueBorrows] = await pool.query(
      `SELECT COUNT(*) AS count FROM mst_document 
       WHERE is_deleted = 0 AND expiry_date IS NOT NULL AND expiry_date < CURDATE()`
    );

    const summary = {};
    statusCount.forEach(r => { summary[r.status] = Number(r.count); });

    res.json({
      summary,
      expiring_soon: Number(expiringSoon[0].count),
      active_borrows: Number(activeBorrows[0].count),
      overdue_borrows: Number(overdueBorrows[0].count),
      recent_documents: recentDocs,
    });
  } catch (err) {
    console.error("[getDashboard]", err);
    res.status(500).json({ message: "Gagal memuat dashboard" });
  }
};

// GET /doc-alora/dashboard/overview — Ringkasan untuk dashboard keputusan
// Query: company_id (id | "custom") → batasi seluruh dashboard ke satu entitas
// "Terpantau" = dokumen berstatus active/expired. inactive/archived tidak dihitung risiko.
export const getDashboardOverview = async (req, res) => {
  try {
    await checkAndUpdateExpiredDocuments();

    const companyFilter = req.query.company_id?.trim() || "";
    const base = ["d.is_deleted = 0"];
    const baseParams = [];
    if (companyFilter === "custom") base.push("d.company_id IS NULL");
    else if (companyFilter) { base.push("d.company_id = ?"); baseParams.push(Number(companyFilter)); }

    const tracked = [...base, "d.status IN ('active','expired')"].join(" AND ");
    const caseSum = (sql) => `COALESCE(SUM(CASE WHEN ${sql} THEN 1 ELSE 0 END), 0)`;
    const B = EXPIRY_BUCKET_SQL;

    const [[today]] = await pool.query(`SELECT CURDATE() AS today`);

    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS total,
              ${caseSum(B.expired)} AS expired,
              ${caseSum(B["30"])}   AS b30,
              ${caseSum(B["60"])}   AS b60,
              ${caseSum(B["90"])}   AS b90,
              ${caseSum(B.safe)}    AS safe,
              ${caseSum(B.none)}    AS no_expiry,
              ${caseSum("NOT EXISTS (SELECT 1 FROM mst_document_attachment a WHERE a.document_id = d.id AND a.is_deleted = 0)")} AS no_attachment
       FROM mst_document d WHERE ${tracked}`,
      baseParams
    );

    const [[inactive]] = await pool.query(
      `SELECT COUNT(*) AS n FROM mst_document d WHERE ${base.join(" AND ")} AND d.status IN ('inactive','archived')`,
      baseParams
    );

    // Jadwal kadaluarsa 12 bulan ke depan (mulai bulan berjalan)
    const monthRows = await safeQuery(
      `SELECT DATE_FORMAT(d.expiry_date, '%Y-%m') AS ym, COUNT(*) AS n
       FROM mst_document d
       WHERE ${tracked}
         AND d.expiry_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
         AND d.expiry_date <  DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 12 MONTH)
       GROUP BY ym`,
      baseParams
    );
    const monthMap = new Map(monthRows.map(r => [r.ym, Number(r.n)]));
    const [ty, tm] = String(today.today).split("-").map(Number);
    const months = Array.from({ length: 12 }, (_, i) => {
      const dt = new Date(Date.UTC(ty, tm - 1 + i, 1));
      const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
      return { ym, count: monthMap.get(ym) || 0 };
    });

    // Per entitas
    const byEntity = await safeQuery(
      `SELECT d.company_id,
              COALESCE(c.company_name, 'Lainnya (custom)') AS name,
              COUNT(*) AS total,
              ${caseSum(B.expired)} AS expired,
              ${caseSum(`d.expiry_date IS NOT NULL AND ${DD} BETWEEN 0 AND 90`)} AS soon
       FROM mst_document d
       LEFT JOIN mst_company c ON c.company_id = d.company_id
       WHERE ${tracked}
       GROUP BY d.company_id, c.company_name
       ORDER BY (expired + soon) DESC, total DESC`,
      baseParams
    );

    // Beban risiko per PIC & departemen (kadaluarsa + ≤60 hari)
    const riskCols = `${caseSum(B.expired)} AS expired,
              ${caseSum(`d.expiry_date IS NOT NULL AND ${DD} BETWEEN 0 AND 60`)} AS soon`;
    const byPic = await safeQuery(
      `SELECT d.pic_id AS id, e.full_name AS name, COUNT(*) AS total, ${riskCols}
       FROM mst_document d
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       WHERE ${tracked}
       GROUP BY d.pic_id, e.full_name
       HAVING expired + soon > 0
       ORDER BY expired + soon DESC, expired DESC LIMIT 6`,
      baseParams
    );
    const byDept = await safeQuery(
      `SELECT d.department_id AS id, dept.department_name AS name, COUNT(*) AS total, ${riskCols}
       FROM mst_document d
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       WHERE ${tracked}
       GROUP BY d.department_id, dept.department_name
       HAVING expired + soon > 0
       ORDER BY expired + soon DESC, expired DESC LIMIT 6`,
      baseParams
    );

    // Daftar prioritas: kadaluarsa + ≤90 hari, paling mendesak dulu
    const attentionWhere = `${tracked} AND d.expiry_date IS NOT NULL AND ${DD} <= 90`;
    const [[attentionCount]] = await pool.query(
      `SELECT COUNT(*) AS n FROM mst_document d WHERE ${attentionWhere}`, baseParams
    );
    const attention = await safeQuery(
      `SELECT d.id, d.document_name, d.document_number, ${numbersSql("d")} AS document_numbers,
              d.entity, d.company_id, c.company_name AS entity_company_name, o.name AS entity_outlet_name,
              d.expiry_date, ${DD} AS days_left, d.status,
              e.full_name AS pic_name, dept.department_name,
              EXISTS (SELECT 1 FROM tr_document_transaction t
                      WHERE t.document_id = d.id AND t.is_deleted = 0 AND t.status IN ('borrowed','overdue')) AS is_borrowed
       FROM mst_document d
       LEFT JOIN mst_company c ON c.company_id = d.company_id
       LEFT JOIN mst_outlet o ON o.id = d.outlet_id
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       WHERE ${attentionWhere}
       ORDER BY d.expiry_date ASC, d.id ASC LIMIT 12`,
      baseParams
    );

    // Peminjaman
    const loanWhere = `t.is_deleted = 0 AND t.status IN ('borrowed','overdue') AND d.is_deleted = 0
       ${baseParams.length || companyFilter === "custom" ? "AND " + base.slice(1).join(" AND ") : ""}`;
    const [[loanCount]] = await pool.query(
      `SELECT COUNT(*) AS borrowed,
              ${caseSum("t.return_due < CURDATE()")} AS overdue
       FROM tr_document_transaction t JOIN mst_document d ON d.id = t.document_id
       WHERE ${loanWhere}`,
      baseParams
    );
    const overdueLoans = await safeQuery(
      `SELECT t.id, t.transaction_code, d.document_name, e.full_name AS borrower_name,
              t.return_due, DATEDIFF(CURDATE(), t.return_due) AS days_late
       FROM tr_document_transaction t
       JOIN mst_document d ON d.id = t.document_id
       LEFT JOIN mst_employee e ON e.employee_id = t.borrowed_by
       WHERE ${loanWhere} AND t.return_due < CURDATE()
       ORDER BY t.return_due ASC LIMIT 5`,
      baseParams
    );

    const n = (v) => Number(v) || 0;
    res.json({
      today: today.today,
      counts: {
        total: n(counts.total), expired: n(counts.expired), b30: n(counts.b30), b60: n(counts.b60),
        b90: n(counts.b90), safe: n(counts.safe), no_expiry: n(counts.no_expiry),
        no_attachment: n(counts.no_attachment), inactive: n(inactive.n),
      },
      months,
      by_entity: byEntity.map(r => ({ ...r, total: n(r.total), expired: n(r.expired), soon: n(r.soon) })),
      by_pic: byPic.map(r => ({ ...r, total: n(r.total), expired: n(r.expired), soon: n(r.soon) })),
      by_department: byDept.map(r => ({ ...r, total: n(r.total), expired: n(r.expired), soon: n(r.soon) })),
      attention: { total: n(attentionCount.n), rows: attention.map(r => ({ ...r, days_left: n(r.days_left), is_borrowed: !!r.is_borrowed })) },
      loans: { borrowed: n(loanCount.borrowed), overdue: n(loanCount.overdue), overdue_rows: overdueLoans.map(r => ({ ...r, days_late: n(r.days_late) })) },
    });
  } catch (err) {
    console.error("[getDashboardOverview]", err);
    res.status(500).json({ message: "Gagal memuat dashboard" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTION (Peminjaman / Pengembalian Dokumen)
// ════════════════════════════════════════════════════════════════════════════

// GET /doc-alora/transactions — List transactions
export const listTransactions = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || "";
    const status = req.query.status?.trim() || "";
    const overdue = req.query.overdue === "true";

    const conditions = ["t.is_deleted = 0"];
    const params = [];

    if (search) {
      conditions.push(`(t.transaction_code LIKE ? OR d.document_name LIKE ? OR e.full_name LIKE ?
        OR EXISTS (SELECT 1 FROM mst_document_number sn WHERE sn.document_id = d.id AND sn.document_number LIKE ?))`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
    }
    if (overdue) {
      conditions.push("t.status IN ('borrowed','overdue') AND t.return_due < CURDATE()");
    }
    if (req.query.active === "true") {
      conditions.push("t.status IN ('borrowed','overdue')");
    }
    const txCompany = req.query.company_id?.trim() || "";
    if (txCompany === "custom") {
      conditions.push("d.company_id IS NULL");
    } else if (txCompany) {
      conditions.push("d.company_id = ?");
      params.push(Number(txCompany));
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countRows = await safeQuery(
      `SELECT COUNT(*) AS total 
       FROM tr_document_transaction t
       LEFT JOIN mst_document d ON d.id = t.document_id
       LEFT JOIN mst_employee e ON e.employee_id = t.borrowed_by
       ${where}`,
      params
    );
    const total = Number(countRows[0].total);

    const data = await safeQuery(
      `SELECT t.*, 
              d.document_name, COALESCE(${numbersSql("d")}, d.document_number) AS document_number,
              e.full_name AS borrower_name,
              dept.department_name,
              appr.full_name AS approver_name
       FROM tr_document_transaction t
       LEFT JOIN mst_document d ON d.id = t.document_id
       LEFT JOIN mst_employee e ON e.employee_id = t.borrowed_by
       LEFT JOIN mst_department dept ON dept.department_id = t.department_id
       LEFT JOIN mst_employee appr ON appr.employee_id = t.approved_by
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data, total, page, limit });
  } catch (err) {
    console.error("[listTransactions]", err);
    res.status(500).json({ message: "Gagal memuat data transaksi" });
  }
};

// GET /doc-alora/transactions/:id — Detail transaction
export const getTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await safeQuery(
      `SELECT t.*, 
              d.document_name, COALESCE(${numbersSql("d")}, d.document_number) AS document_number,
              e.full_name AS borrower_name,
              dept.department_name,
              appr.full_name AS approver_name
       FROM tr_document_transaction t
       LEFT JOIN mst_document d ON d.id = t.document_id
       LEFT JOIN mst_employee e ON e.employee_id = t.borrowed_by
       LEFT JOIN mst_department dept ON dept.department_id = t.department_id
       LEFT JOIN mst_employee appr ON appr.employee_id = t.approved_by
       WHERE t.id = ? AND t.is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Transaksi tidak ditemukan" });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error("[getTransaction]", err);
    res.status(500).json({ message: "Gagal memuat detail transaksi" });
  }
};

// POST /doc-alora/transactions — Create borrow transaction
export const createTransaction = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const {
      document_id, department_id, purpose, borrow_date, return_due,
      condition_on_borrow, notes
    } = req.body;

    if (!document_id || !purpose || !borrow_date || !return_due) {
      return res.status(400).json({ message: "Field wajib belum lengkap" });
    }

    // Check document exists and is active
    const doc = await safeQuery(
      `SELECT * FROM mst_document WHERE id = ? AND is_deleted = 0`, [document_id]
    );
    if (!doc.length) return res.status(404).json({ message: "Dokumen tidak ditemukan" });

    const transactionCode = await generateTransactionCode();

    // Get borrower's department if not provided
    let deptId = department_id ? Number(department_id) : null;
    if (!deptId) {
      const emp = await safeQuery(
        `SELECT department_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0`,
        [employeeId]
      );
      if (emp.length) deptId = emp[0].department_id;
    }

    await safeQuery(
      `INSERT INTO tr_document_transaction
        (document_id, transaction_code, borrowed_by, department_id, purpose,
         borrow_date, return_due, condition_on_borrow, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(document_id), transactionCode, employeeId, deptId,
        sanitize(purpose), borrow_date, return_due,
        condition_on_borrow || "good", sanitize(notes), employeeId
      ]
    );

    res.status(201).json({ message: "Peminjaman berhasil dicatat", transaction_code: transactionCode });
  } catch (err) {
    console.error("[createTransaction]", err);
    res.status(500).json({ message: "Gagal mencatat peminjaman" });
  }
};

// PUT /doc-alora/transactions/:id — Update transaction (e.g., return)
export const updateTransaction = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const existing = await safeQuery(
      `SELECT * FROM tr_document_transaction WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Transaksi tidak ditemukan" });

    const {
      actual_return, condition_on_return, status, notes
    } = req.body;

    const updates = [];
    const params = [];

    if (actual_return) { updates.push("actual_return = ?"); params.push(actual_return); }
    if (condition_on_return) { updates.push("condition_on_return = ?"); params.push(condition_on_return); }
    if (status) { updates.push("status = ?"); params.push(status); }
    if (notes !== undefined) { updates.push("notes = ?"); params.push(sanitize(notes)); }

    updates.push("updated_by = ?");
    params.push(employeeId);
    params.push(id);

    if (updates.length <= 1) {
      return res.status(400).json({ message: "Tidak ada field yang diubah" });
    }

    await safeQuery(
      `UPDATE tr_document_transaction SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    res.json({ message: "Transaksi berhasil diperbarui" });
  } catch (err) {
    console.error("[updateTransaction]", err);
    res.status(500).json({ message: "Gagal memperbarui transaksi" });
  }
};

// POST /doc-alora/transactions/:id/return — Return document
export const returnDocument = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const existing = await safeQuery(
      `SELECT * FROM tr_document_transaction WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Transaksi tidak ditemukan" });
    if (existing[0].status === "returned") {
      return res.status(400).json({ message: "Dokumen sudah dikembalikan" });
    }

    const { condition_on_return, notes } = req.body;

    await safeQuery(
      `UPDATE tr_document_transaction SET
        actual_return = CURDATE(), condition_on_return = ?, status = 'returned',
        notes = ?, updated_by = ?
       WHERE id = ?`,
      [condition_on_return || "good", sanitize(notes) || existing[0].notes, employeeId, id]
    );

    res.json({ message: "Dokumen berhasil dikembalikan" });
  } catch (err) {
    console.error("[returnDocument]", err);
    res.status(500).json({ message: "Gagal mengembalikan dokumen" });
  }
};

// POST /doc-alora/transactions/:id/approve — Approve transaction
export const approveTransaction = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const existing = await safeQuery(
      `SELECT * FROM tr_document_transaction WHERE id = ? AND is_deleted = 0`, [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Transaksi tidak ditemukan" });

    await safeQuery(
      `UPDATE tr_document_transaction SET approved_by = ?, approved_at = NOW(), updated_by = ? WHERE id = ?`,
      [employeeId, employeeId, id]
    );

    res.json({ message: "Transaksi disetujui" });
  } catch (err) {
    console.error("[approveTransaction]", err);
    res.status(500).json({ message: "Gagal menyetujui transaksi" });
  }
};

// DELETE /doc-alora/transactions/:id — Soft delete
export const deleteTransaction = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    await safeQuery(
      `UPDATE tr_document_transaction SET is_deleted = 1, updated_by = ? WHERE id = ?`,
      [employeeId, id]
    );

    res.json({ message: "Transaksi berhasil dihapus" });
  } catch (err) {
    console.error("[deleteTransaction]", err);
    res.status(500).json({ message: "Gagal menghapus transaksi" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// LOOKUP Endpoints (untuk dropdown)
// ════════════════════════════════════════════════════════════════════════════

// GET /doc-alora/lookup/employees — List employees for PIC dropdown
export const lookupEmployees = async (_req, res) => {
  try {
    const data = await safeQuery(
      `SELECT employee_id, full_name, department_id FROM mst_employee 
       WHERE is_deleted = 0 ORDER BY full_name`
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupEmployees]", err);
    res.status(500).json({ message: "Gagal memuat data karyawan" });
  }
};

// GET /doc-alora/lookup/departments — List departments
export const lookupDepartments = async (_req, res) => {
  try {
    const data = await safeQuery(
      `SELECT department_id, department_name FROM mst_department 
       WHERE is_active = 1 ORDER BY department_name`
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupDepartments]", err);
    res.status(500).json({ message: "Gagal memuat data departemen" });
  }
};

// GET /doc-alora/lookup/companies — List companies (for archive_location)
export const lookupCompanies = async (_req, res) => {
  try {
    const data = await safeQuery(
      `SELECT company_id, company_name FROM mst_company 
       WHERE is_active = 1 ORDER BY company_name`
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupCompanies]", err);
    res.status(500).json({ message: "Gagal memuat data perusahaan" });
  }
};

// GET /doc-alora/lookup/outlets — List outlet (turunan company_id = 5)
export const lookupOutlets = async (_req, res) => {
  try {
    const data = await safeQuery(
      `SELECT id AS outlet_id, name AS outlet_name, full_name, ? AS company_id
       FROM mst_outlet ORDER BY name`,
      [OUTLET_COMPANY_ID]
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupOutlets]", err);
    res.status(500).json({ message: "Gagal memuat data outlet" });
  }
};

// GET /doc-alora/lookup/documents — List documents for transaction dropdown
export const lookupDocuments = async (_req, res) => {
  try {
    await checkAndUpdateExpiredDocuments();
    const data = await safeQuery(
      `SELECT d.id, d.document_name, COALESCE(${numbersSql("d")}, d.document_number) AS document_number
       FROM mst_document d
       WHERE d.is_deleted = 0 AND d.status = 'active' ORDER BY d.document_name`
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupDocuments]", err);
    res.status(500).json({ message: "Gagal memuat data dokumen" });
  }
};
