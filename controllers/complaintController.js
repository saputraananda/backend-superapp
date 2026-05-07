import { safeQuery, safeSmartlinkQuery } from "../db/pool.js";
import fs from "fs";
import path from "path";

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(process.cwd(), "assets");

function removeFile(relativePath) {
  if (!relativePath) return;
  const cleaned = String(relativePath).replace(/^\/+/, "");
  const full = path.join(ASSETS_BASE, cleaned);
  if (fs.existsSync(full)) {
    try { fs.unlinkSync(full); } catch (_) { /* ignore */ }
  }
}

// ─── Master data ──────────────────────────────────────────────────────────────

export const getComplaintMeta = async (_req, res) => {
  try {
    const [[types], [categories], [topics], [outlets]] = await Promise.all([
      safeQuery("SELECT type_id, type_name FROM mst_complaint_type WHERE is_active=1 ORDER BY sort_order", []),
      safeQuery("SELECT category_id, category_name FROM mst_complaint_category WHERE is_active=1 ORDER BY sort_order", []),
      safeQuery("SELECT topic_id, topic_name FROM mst_complaint_topic WHERE is_active=1 ORDER BY sort_order", []),
      safeQuery("SELECT id, name, full_name FROM mst_outlet ORDER BY name ASC", []),
    ]);
    res.json({ types, categories, topics, outlets });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Customers (for complaint_name autocomplete) ──────────────────────────────

export const getComplaintCustomers = async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : "%";
    console.log("[getComplaintCustomers] q:", req.query.q, "| search:", search);
    const [rows] = await safeSmartlinkQuery(
      "SELECT id AS customer_id, nama FROM customer WHERE nama LIKE ? ORDER BY nama ASC LIMIT 50",
      [search]
    );
    console.log("[getComplaintCustomers] rows:", rows.length);
    res.json(rows);
  } catch (err) {
    console.error("[getComplaintCustomers] ERROR:", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ─── Employees (for PIC autocomplete) ────────────────────────────────────────

export const getComplaintEmployees = async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : "%";
    const [rows] = await safeQuery(
      "SELECT employee_id, full_name FROM mst_employee WHERE company_id = 1 AND exit_date IS NULL AND (is_deleted = 0 OR is_deleted IS NULL) AND full_name LIKE ? ORDER BY full_name ASC LIMIT 50",
      [search]
    );
    res.json(rows);
  } catch (err) {
    console.error("[getComplaintEmployees]", err.message);
    res.status(500).json({ message: err.message });
  }
};

// ─── Summary / Dashboard ──────────────────────────────────────────────────────

export const getComplaintSummary = async (req, res) => {
  try {
    const dateWhere = [];
    const dateParams = [];
    if (req.query.start_date) { dateWhere.push("DATE(created_at) >= ?"); dateParams.push(req.query.start_date); }
    if (req.query.end_date) { dateWhere.push("DATE(created_at) <= ?"); dateParams.push(req.query.end_date); }
    const dw = dateWhere.length ? `WHERE ${dateWhere.join(" AND ")}` : "";
    const cJoinWhere = dateWhere.length
      ? `WHERE ${dateWhere.map(s => s.replace("created_at", "c.created_at")).join(" AND ")}`
      : "";

    const [[totals]] = await safeQuery(
      `SELECT
        COUNT(*) AS total,
        SUM(progress = 'Open') AS open_count,
        SUM(progress = 'On Progress') AS on_progress_count,
        SUM(progress = 'Waiting Customer') AS waiting_count,
        SUM(progress = 'Resolved') AS resolved_count,
        SUM(progress = 'Closed') AS closed_count
       FROM tr_complaint ${dw}`,
      dateParams
    );

    const [byOutlet] = await safeQuery(
      `SELECT c.outlet_id, o.name AS outlet_name, COUNT(*) AS total,
              SUM(c.progress NOT IN ('Resolved','Closed')) AS open_total
       FROM tr_complaint c
       LEFT JOIN mst_outlet o ON o.id = c.outlet_id
       ${cJoinWhere}
       GROUP BY c.outlet_id, o.name
       ORDER BY total DESC
       LIMIT 10`,
      dateParams
    );

    const [byTopic] = await safeQuery(
      `SELECT t.topic_name, COUNT(*) AS total
       FROM tr_complaint c
       JOIN mst_complaint_topic t ON t.topic_id = c.topic_id
       ${cJoinWhere}
       GROUP BY c.topic_id, t.topic_name
       ORDER BY total DESC`,
      dateParams
    );

    const [byType] = await safeQuery(
      `SELECT t.type_name, COUNT(*) AS total
       FROM tr_complaint c
       JOIN mst_complaint_type t ON t.type_id = c.type_id
       ${cJoinWhere}
       GROUP BY c.type_id, t.type_name
       ORDER BY total DESC`,
      dateParams
    );

    const [recentTrend] = await safeQuery(
      `SELECT DATE_FORMAT(created_at,'%Y-%m') AS month, COUNT(*) AS total
       FROM tr_complaint
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
       GROUP BY month
       ORDER BY month ASC`,
      []
    );

    res.json({ totals: totals[0] || totals, byOutlet, byTopic, byType, recentTrend });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── List complaints ──────────────────────────────────────────────────────────

export const getComplaints = async (req, res) => {
  try {
    const where = [];
    const params = [];

    if (req.query.outlet_id) { where.push("c.outlet_id = ?"); params.push(Number(req.query.outlet_id)); }
    if (req.query.progress) { where.push("c.progress = ?"); params.push(req.query.progress); }
    if (req.query.type_id) { where.push("c.type_id = ?"); params.push(Number(req.query.type_id)); }
    if (req.query.topic_id) { where.push("c.topic_id = ?"); params.push(Number(req.query.topic_id)); }
    if (req.query.search) {
      where.push("(c.complaint_name LIKE ? OR c.nota_number LIKE ?)");
      const s = `%${req.query.search}%`;
      params.push(s, s);
    }
    if (req.query.start_date) { where.push("DATE(c.created_at) >= ?"); params.push(req.query.start_date); }
    if (req.query.end_date) { where.push("DATE(c.created_at) <= ?"); params.push(req.query.end_date); }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const orderDir = req.query.order_dir?.toUpperCase() === "ASC" ? "ASC" : "DESC";
    const limit = req.query.limit === "all" ? 99999 : Math.min(Math.max(Number(req.query.limit || 25), 1), 99999);
    const offset = Math.max(Number(req.query.offset || 0), 0);

    const [rows] = await safeQuery(
      `SELECT
         c.complaint_id, c.outlet_id, o.name AS outlet_name,
         c.type_id, ct.type_name,
         c.category_id, cc.category_name,
         c.topic_id, cp.topic_name,
         c.complaint_name, c.nota_number, c.qty, c.description,
         c.deduction, c.pic_employee_id, c.pic_name,
         c.progress, c.created_at, c.updated_at
       FROM tr_complaint c
       LEFT JOIN mst_outlet           o  ON o.id         = c.outlet_id
       LEFT JOIN mst_complaint_type   ct ON ct.type_id   = c.type_id
       LEFT JOIN mst_complaint_category cc ON cc.category_id = c.category_id
       LEFT JOIN mst_complaint_topic  cp ON cp.topic_id  = c.topic_id
       ${whereClause}
       ORDER BY c.created_at ${orderDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) AS total FROM tr_complaint c ${whereClause}`,
      params
    );

    res.json({ complaints: rows, total, limit, offset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Get single complaint with logs ───────────────────────────────────────────

export const getComplaintById = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "ID tidak valid." });

    const [complaintRows] = await safeQuery(
      `SELECT c.*,
         o.name AS outlet_name,
         ct.type_name, cc.category_name, cp.topic_name
       FROM tr_complaint c
       LEFT JOIN mst_outlet           o  ON o.id         = c.outlet_id
       LEFT JOIN mst_complaint_type   ct ON ct.type_id   = c.type_id
       LEFT JOIN mst_complaint_category cc ON cc.category_id = c.category_id
       LEFT JOIN mst_complaint_topic  cp ON cp.topic_id  = c.topic_id
       WHERE c.complaint_id = ?`,
      [id]
    );
    if (!complaintRows.length) return res.status(404).json({ message: "Komplain tidak ditemukan." });

    const [docs] = await safeQuery(
      "SELECT * FROM tr_complaint_document WHERE complaint_id = ? ORDER BY uploaded_at ASC",
      [id]
    );

    const [logs] = await safeQuery(
      `SELECT * FROM tr_complaint_progress_log WHERE complaint_id = ? ORDER BY logged_at ASC`,
      [id]
    );

    const logIds = logs.map((l) => l.log_id);
    let progressDocs = [];
    if (logIds.length) {
      const placeholders = logIds.map(() => "?").join(",");
      [progressDocs] = await safeQuery(
        `SELECT * FROM tr_complaint_progress_document WHERE log_id IN (${placeholders}) ORDER BY uploaded_at ASC`,
        logIds
      );
    }

    const logsWithDocs = logs.map((log) => ({
      ...log,
      documents: progressDocs.filter((d) => d.log_id === log.log_id),
    }));

    res.json({ complaint: complaintRows[0], documents: docs, progressLogs: logsWithDocs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Create complaint ─────────────────────────────────────────────────────────

export const createComplaint = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const typeId = Number(req.body.type_id || 0);
    const categoryId = Number(req.body.category_id || 0);
    const topicId = Number(req.body.topic_id || 0);
    const outletId = Number(req.body.outlet_id || 0);
    const name = String(req.body.complaint_name || "").trim();
    const nota = String(req.body.nota_number || "").trim();
    const qty = Math.max(Number(req.body.qty || 1), 1);
    const description = String(req.body.description || "").trim();
    const deduction = ["None", "Company", "Management"].includes(req.body.deduction) ? req.body.deduction : "None";
    const picEmployeeId = req.body.pic_employee_id ? Number(req.body.pic_employee_id) : null;
    const picName = String(req.body.pic_name || "").trim() || null;

    if (!typeId || !categoryId || !topicId || !outletId || !name || !nota || !description) {
      return res.status(400).json({ message: "Semua field wajib diisi." });
    }

    const [insertResult] = await safeQuery(
      `INSERT INTO tr_complaint
         (type_id, category_id, topic_id, outlet_id, complaint_name, nota_number,
          qty, description, deduction, pic_employee_id, pic_name, progress,
          submitted_at,
          created_by_user_id, created_by_employee_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'Open',COALESCE(?, NOW()),?,?)`,
      [typeId, categoryId, topicId, outletId, name, nota, qty, description,
        deduction, picEmployeeId, picName,
        req.body.submitted_at || null,
        Number(userId), req.session?.employeeId ? Number(req.session.employeeId) : null]
    );

    const complaintId = insertResult.insertId;

    // Save documents
    const files = req.files || [];
    for (const file of files) {
      await safeQuery(
        `INSERT INTO tr_complaint_document (complaint_id, file_path, original_name, mime_type, file_size_kb)
         VALUES (?,?,?,?,?)`,
        [complaintId, `complaint_docs/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
      );
    }

    // Auto-create first progress log
    await safeQuery(
      `INSERT INTO tr_complaint_progress_log
         (complaint_id, progress, note, pic_employee_id, pic_name, logged_by_user_id, logged_by_employee_id)
       VALUES (?,?,?,?,?,?,?)`,
      [complaintId, "Open", "Komplain dibuat.", picEmployeeId, picName,
        Number(userId), req.session?.employeeId ? Number(req.session.employeeId) : null]
    );

    res.status(201).json({ message: "Komplain berhasil disimpan.", complaint_id: complaintId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Update complaint ─────────────────────────────────────────────────────────

export const updateComplaint = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "ID tidak valid." });

    const [existing] = await safeQuery(
      "SELECT complaint_id FROM tr_complaint WHERE complaint_id = ?", [id]
    );
    if (!existing.length) return res.status(404).json({ message: "Komplain tidak ditemukan." });

    const typeId = Number(req.body.type_id || 0);
    const categoryId = Number(req.body.category_id || 0);
    const topicId = Number(req.body.topic_id || 0);
    const outletId = Number(req.body.outlet_id || 0);
    const name = String(req.body.complaint_name || "").trim();
    const nota = String(req.body.nota_number || "").trim();
    const qty = Math.max(Number(req.body.qty || 1), 1);
    const description = String(req.body.description || "").trim();
    const deduction = ["None", "Company", "Management"].includes(req.body.deduction) ? req.body.deduction : "None";
    const picEmployeeId = req.body.pic_employee_id ? Number(req.body.pic_employee_id) : null;
    const picName = String(req.body.pic_name || "").trim() || null;

    if (!typeId || !categoryId || !topicId || !outletId || !name || !nota || !description) {
      return res.status(400).json({ message: "Semua field wajib diisi." });
    }

    await safeQuery(
      `UPDATE tr_complaint SET
         type_id=?, category_id=?, topic_id=?, outlet_id=?,
         complaint_name=?, nota_number=?, qty=?, description=?,
         deduction=?, pic_employee_id=?, pic_name=?,
         submitted_at=COALESCE(?, submitted_at),
         duration_to_resolve = IF(resolved_at IS NOT NULL, TIMESTAMPDIFF(MINUTE, COALESCE(?, submitted_at), resolved_at), duration_to_resolve),
         duration_to_close = IF(closed_at IS NOT NULL, TIMESTAMPDIFF(MINUTE, COALESCE(?, submitted_at), closed_at), duration_to_close),
         updated_at=NOW()
       WHERE complaint_id=?`,
      [typeId, categoryId, topicId, outletId, name, nota, qty, description,
        deduction, picEmployeeId, picName,
        req.body.submitted_at || null, req.body.submitted_at || null, req.body.submitted_at || null,
        id]
    );

    // Handle new file uploads
    const files = req.files || [];
    for (const file of files) {
      await safeQuery(
        `INSERT INTO tr_complaint_document (complaint_id, file_path, original_name, mime_type, file_size_kb)
         VALUES (?,?,?,?,?)`,
        [id, `complaint_docs/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
      );
    }

    // Handle deleted docs
    let deletedDocIds = [];
    try { deletedDocIds = JSON.parse(req.body.deleted_doc_ids || "[]"); } catch (_) { }
    if (deletedDocIds.length) {
      const [delDocs] = await safeQuery(
        `SELECT file_path FROM tr_complaint_document WHERE doc_id IN (${deletedDocIds.map(() => "?").join(",")}) AND complaint_id=?`,
        [...deletedDocIds.map(Number), id]
      );
      delDocs.forEach((d) => removeFile(d.file_path));
      await safeQuery(
        `DELETE FROM tr_complaint_document WHERE doc_id IN (${deletedDocIds.map(() => "?").join(",")}) AND complaint_id=?`,
        [...deletedDocIds.map(Number), id]
      );
    }

    res.json({ message: "Komplain berhasil diupdate." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Delete complaint ─────────────────────────────────────────────────────────

export const deleteComplaint = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "ID tidak valid." });

    const [docs] = await safeQuery("SELECT file_path FROM tr_complaint_document WHERE complaint_id=?", [id]);
    const [pdocs] = await safeQuery(
      `SELECT pd.file_path FROM tr_complaint_progress_document pd
       JOIN tr_complaint_progress_log pl ON pl.log_id = pd.log_id
       WHERE pl.complaint_id = ?`, [id]
    );
    [...docs, ...pdocs].forEach((d) => removeFile(d.file_path));

    await safeQuery("DELETE FROM tr_complaint WHERE complaint_id=?", [id]);
    res.json({ message: "Komplain berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Add progress log ─────────────────────────────────────────────────────────

export const addProgressLog = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "ID tidak valid." });

    const [existing] = await safeQuery("SELECT complaint_id, submitted_at, in_progress_at, waiting_customer_at, resolved_at, closed_at FROM tr_complaint WHERE complaint_id=?", [id]);
    if (!existing.length) return res.status(404).json({ message: "Komplain tidak ditemukan." });

    const progress = req.body.progress;
    const validProgress = ["Open", "On Progress", "Waiting Customer", "Resolved", "Closed"];
    if (!validProgress.includes(progress)) {
      return res.status(400).json({ message: "Progress tidak valid." });
    }

    const note = String(req.body.note || "").trim() || null;
    const picEmployeeId = req.body.pic_employee_id ? Number(req.body.pic_employee_id) : null;
    const picName = String(req.body.pic_name || "").trim() || null;

    const [logResult] = await safeQuery(
      `INSERT INTO tr_complaint_progress_log
         (complaint_id, progress, note, pic_employee_id, pic_name, logged_by_user_id, logged_by_employee_id)
       VALUES (?,?,?,?,?,?,?)`,
      [id, progress, note, picEmployeeId, picName,
        Number(userId), req.session?.employeeId ? Number(req.session.employeeId) : null]
    );

    const logId = logResult.insertId;

    // Save progress documents
    const files = req.files || [];
    for (const file of files) {
      await safeQuery(
        `INSERT INTO tr_complaint_progress_document (log_id, file_path, original_name, mime_type, file_size_kb)
         VALUES (?,?,?,?,?)`,
        [logId, `complaint_docs/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
      );
    }

    // Determine new values
    let updateFields = ["progress=?", "updated_at=NOW()"];
    let updateValues = [progress];

    const cRow = existing[0];
    if (progress === "On Progress" && !cRow.in_progress_at) {
      updateFields.push("in_progress_at=NOW()");
    }
    if (progress === "Waiting Customer" && !cRow.waiting_customer_at) {
      updateFields.push("waiting_customer_at=NOW()");
    }
    if (progress === "Resolved" && !cRow.resolved_at) {
      updateFields.push("resolved_at=NOW()");
      updateFields.push("duration_to_resolve=TIMESTAMPDIFF(MINUTE, submitted_at, NOW())");
    }
    if (progress === "Closed" && !cRow.closed_at) {
      updateFields.push("closed_at=NOW()");
      updateFields.push("duration_to_close=TIMESTAMPDIFF(MINUTE, submitted_at, NOW())");
    }

    // Update complaint progress
    await safeQuery(
      `UPDATE tr_complaint SET ${updateFields.join(", ")} WHERE complaint_id=?`,
      [...updateValues, id]
    );

    res.status(201).json({ message: "Progress log berhasil ditambahkan.", log_id: logId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
