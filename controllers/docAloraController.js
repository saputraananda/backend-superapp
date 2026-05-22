// ════════════════════════════════════════════════════════════════════════════
// ALORA DOCUMENT MANAGEMENT SYSTEM — Controller
//
// Tables:
//   mst_document               → Master dokumen perusahaan
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

const getEmployeeId = (req) =>
  req.session?.employeeId ?? req.session?.employee_id ?? null;

const sanitize = (str) => {
  if (str == null) return null;
  return String(str)
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
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
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = req.query.search?.trim() || "";
    const status = req.query.status?.trim() || "";
    const departmentId = req.query.department_id ? Number(req.query.department_id) : null;

    const conditions = ["d.is_deleted = 0"];
    const params = [];

    if (search) {
      conditions.push("(d.document_name LIKE ? OR d.document_number LIKE ? OR d.entity LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      conditions.push("d.status = ?");
      params.push(status);
    }
    if (departmentId) {
      conditions.push("d.department_id = ?");
      params.push(departmentId);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;

    const countRows = await safeQuery(
      `SELECT COUNT(*) AS total FROM mst_document d ${where}`,
      params
    );
    const total = Number(countRows[0].total);

    const data = await safeQuery(
      `SELECT d.*, 
              e.full_name AS pic_name,
              dept.department_name,
              c.company_name AS archive_location_name,
              (SELECT COUNT(*) FROM mst_document_attachment a WHERE a.document_id = d.id AND a.is_deleted = 0) AS attachment_count
       FROM mst_document d
       LEFT JOIN mst_employee e ON e.employee_id = d.pic_id
       LEFT JOIN mst_department dept ON dept.department_id = d.department_id
       LEFT JOIN mst_company c ON c.company_id = d.archive_location
       ${where}
       ORDER BY d.created_at DESC
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
    const { id } = req.params;
    const rows = await safeQuery(
      `SELECT d.*, 
              e.full_name AS pic_name,
              dept.department_name,
              c.company_name AS archive_location_name
       FROM mst_document d
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

    res.json({ data: rows[0], attachments });
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
      document_name, document_number, entity, effective_date, expiry_date,
      validity_period, status, pic_id, department_id, archive_location, notes
    } = req.body;

    if (!document_name || !document_number || !entity || !effective_date || !pic_id || !department_id) {
      return res.status(400).json({ message: "Field wajib belum lengkapi" });
    }

    const result = await safeQuery(
      `INSERT INTO mst_document
        (document_name, document_number, entity, effective_date, expiry_date,
         validity_period, status, pic_id, department_id, archive_location,
         notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sanitize(document_name), sanitize(document_number), sanitize(entity),
        effective_date, expiry_date || null,
        validity_period ? Number(validity_period) : null,
        status || "active", Number(pic_id), Number(department_id),
        archive_location ? Number(archive_location) : null,
        sanitize(notes), employeeId
      ]
    );

    const documentId = result.insertId;

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
      document_name, document_number, entity, effective_date, expiry_date,
      validity_period, status, pic_id, department_id, archive_location, notes
    } = req.body;

    await safeQuery(
      `UPDATE mst_document SET
        document_name = ?, document_number = ?, entity = ?,
        effective_date = ?, expiry_date = ?, validity_period = ?,
        status = ?, pic_id = ?, department_id = ?, archive_location = ?,
        notes = ?, updated_by = ?
       WHERE id = ?`,
      [
        sanitize(document_name), sanitize(document_number), sanitize(entity),
        effective_date, expiry_date || null,
        validity_period ? Number(validity_period) : null,
        status || existing[0].status, Number(pic_id), Number(department_id),
        archive_location ? Number(archive_location) : null,
        sanitize(notes), employeeId, id
      ]
    );

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

    res.json({ message: "Dokumen berhasil dihapus" });
  } catch (err) {
    console.error("[deleteDocument]", err);
    res.status(500).json({ message: "Gagal menghapus dokumen" });
  }
};

// GET /doc-alora/dashboard — Dashboard summary
export const getDashboard = async (req, res) => {
  try {
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
      `SELECT COUNT(*) AS count FROM tr_document_transaction 
       WHERE is_deleted = 0 AND status IN ('borrowed','overdue')
       AND return_due < CURDATE()`
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

    const conditions = ["t.is_deleted = 0"];
    const params = [];

    if (search) {
      conditions.push("(t.transaction_code LIKE ? OR d.document_name LIKE ? OR e.full_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      conditions.push("t.status = ?");
      params.push(status);
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
              d.document_name, d.document_number,
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
              d.document_name, d.document_number,
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

// GET /doc-alora/lookup/documents — List documents for transaction dropdown
export const lookupDocuments = async (_req, res) => {
  try {
    const data = await safeQuery(
      `SELECT id, document_name, document_number FROM mst_document 
       WHERE is_deleted = 0 AND status = 'active' ORDER BY document_name`
    );
    res.json({ data });
  } catch (err) {
    console.error("[lookupDocuments]", err);
    res.status(500).json({ message: "Gagal memuat data dokumen" });
  }
};
