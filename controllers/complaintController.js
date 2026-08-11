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

function getLastCutoffPeriods(count = 6) {
  const now = new Date();
  const currentPeriod = new Date(
    now.getFullYear(),
    now.getMonth() + (now.getDate() > 25 ? 1 : 0),
    1
  );

  return Array.from({ length: count }, (_, index) => {
    const period = new Date(
      currentPeriod.getFullYear(),
      currentPeriod.getMonth() - (count - 1 - index),
      1
    );
    const year = period.getFullYear();
    const month = period.getMonth() + 1;
    return `${year}-${String(month).padStart(2, "0")}`;
  });
}

const syncComplaintProgress = async (complaintId) => {
  const [latestLog] = await safeQuery(
    `SELECT progress FROM tr_complaint_progress_log 
     WHERE complaint_id = ? 
     ORDER BY logged_at DESC, log_id DESC 
     LIMIT 1`,
    [complaintId]
  );

  if (latestLog && latestLog.length > 0) {
    const newProgress = latestLog[0].progress;

    const [datesResult] = await safeQuery(
      `SELECT 
         MIN(IF(progress = 'Open', logged_at, NULL)) as open_at,
         MIN(IF(progress = 'On Progress', logged_at, NULL)) as in_progress_at,
         MIN(IF(progress = 'Waiting Customer', logged_at, NULL)) as waiting_customer_at,
         MIN(IF(progress = 'Resolved', logged_at, NULL)) as resolved_at,
         MIN(IF(progress = 'Closed', logged_at, NULL)) as closed_at
       FROM tr_complaint_progress_log 
       WHERE complaint_id = ?`,
      [complaintId]
    );

    const dates = datesResult[0] || {};
    let updateFields = [
      "progress = ?",
      "in_progress_at = ?",
      "waiting_customer_at = ?",
      "resolved_at = ?",
      "closed_at = ?",
      "updated_at = NOW()"
    ];
    let updateValues = [
      newProgress,
      dates.in_progress_at || null,
      dates.waiting_customer_at || null,
      dates.resolved_at || null,
      dates.closed_at || null
    ];

    if (dates.open_at) {
      updateFields.push("submitted_at = ?");
      updateValues.push(dates.open_at);
    }

    const finalSubmittedAt = dates.open_at || null;

    if (dates.resolved_at && finalSubmittedAt) {
      updateFields.push("duration_to_resolve = GREATEST(TIMESTAMPDIFF(MINUTE, ?, ?), 0)");
      updateValues.push(finalSubmittedAt, dates.resolved_at);
    } else {
      updateFields.push("duration_to_resolve = NULL");
    }

    if (dates.closed_at && finalSubmittedAt) {
      updateFields.push("duration_to_close = GREATEST(TIMESTAMPDIFF(MINUTE, ?, ?), 0)");
      updateValues.push(finalSubmittedAt, dates.closed_at);
    } else {
      updateFields.push("duration_to_close = NULL");
    }

    await safeQuery(
      `UPDATE tr_complaint SET ${updateFields.join(", ")} WHERE complaint_id = ?`,
      [...updateValues, complaintId]
    );
  } else {
    // If no logs left, set progress back to Open
    await safeQuery(
      `UPDATE tr_complaint 
       SET progress = 'Open', 
           in_progress_at = NULL, 
           waiting_customer_at = NULL, 
           resolved_at = NULL, 
           closed_at = NULL,
           duration_to_resolve = NULL,
           duration_to_close = NULL,
           updated_at = NOW() 
       WHERE complaint_id = ?`,
      [complaintId]
    );
  }
};

// ─── Periods (distinct months from submitted_at for filter dropdown) ──────────

export const getComplaintPeriods = async (_req, res) => {
  try {
    // Period is bucketed by the cutoff used on the frontend (cutoff day = 26):
    // a complaint submitted on/after the 26th belongs to the NEXT month's period.
    // e.g. submitted_at 2026-05-28 → "Juni 2026" (cutoff 2026-05-26 s/d 2026-06-25).
    const [rows] = await safeQuery(
      `SELECT DISTINCT
         YEAR(DATE_ADD(submitted_at,  INTERVAL IF(DAY(submitted_at) >= 26, 1, 0) MONTH)) AS year,
         MONTH(DATE_ADD(submitted_at, INTERVAL IF(DAY(submitted_at) >= 26, 1, 0) MONTH)) AS month
       FROM tr_complaint
       WHERE submitted_at IS NOT NULL
       ORDER BY year DESC, month DESC`,
      []
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

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

// ─── Nota autocomplete (no_nota + customer_nama from rekap_transaksi_reguler) ─

export const getComplaintNota = async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : "%";
    const [rows] = await safeSmartlinkQuery(
      `SELECT no_nota, customer_nama
       FROM rekap_transaksi_reguler
       WHERE no_nota LIKE ?
       GROUP BY no_nota, customer_nama
       ORDER BY no_nota ASC
       LIMIT 30`,
      [search]
    );
    res.json(rows);
  } catch (err) {
    console.error("[getComplaintNota] ERROR:", err.message);
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
    if (req.query.start_date) { dateWhere.push("DATE(submitted_at) >= ?"); dateParams.push(req.query.start_date); }
    if (req.query.end_date) { dateWhere.push("DATE(submitted_at) <= ?"); dateParams.push(req.query.end_date); }
    const dw = dateWhere.length ? `WHERE ${dateWhere.join(" AND ")}` : "";
    const cJoinWhere = dateWhere.length
      ? `WHERE ${dateWhere.map(s => s.replace("submitted_at", "c.submitted_at")).join(" AND ")}`
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
      `SELECT c.topic_id, t.topic_name, COUNT(*) AS total
       FROM tr_complaint c
       JOIN mst_complaint_topic t ON t.topic_id = c.topic_id
       ${cJoinWhere}
       GROUP BY c.topic_id, t.topic_name
       ORDER BY total DESC`,
      dateParams
    );

    const [byType] = await safeQuery(
      `SELECT c.type_id, t.type_name, COUNT(*) AS total
       FROM tr_complaint c
       JOIN mst_complaint_type t ON t.type_id = c.type_id
       ${cJoinWhere}
       GROUP BY c.type_id, t.type_name
       ORDER BY total DESC`,
      dateParams
    );

    const [byCategory] = await safeQuery(
      `SELECT c.category_id, cat.category_name, COUNT(*) AS total
       FROM tr_complaint c
       JOIN mst_complaint_category cat ON cat.category_id = c.category_id
       ${cJoinWhere}
       GROUP BY c.category_id, cat.category_name
       ORDER BY total DESC`,
      dateParams
    );

    const cutoffPeriods = getLastCutoffPeriods(6);
    const [recentTrendRows] = await safeQuery(
      `SELECT
         DATE_FORMAT(DATE_ADD(submitted_at, INTERVAL IF(DAY(submitted_at) >= 26, 1, 0) MONTH), '%Y-%m') AS month,
         COUNT(*) AS total
       FROM tr_complaint
       WHERE submitted_at IS NOT NULL
       GROUP BY month
       HAVING month IN (${cutoffPeriods.map(() => "?").join(",")})
       ORDER BY month ASC`,
      cutoffPeriods
    );
    const trendByMonth = new Map(
      recentTrendRows.map((row) => [row.month, Number(row.total) || 0])
    );
    const recentTrend = cutoffPeriods.map((month) => ({
      month,
      total: trendByMonth.get(month) || 0,
    }));

    res.json({ totals: totals[0] || totals, byOutlet, byTopic, byType, byCategory, recentTrend });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Cumulative range comparison (26th → today) across months ──────────

export const getComplaintSameDayComparison = async (req, res) => {
  try {
    const today = req.query.date ? new Date(req.query.date) : new Date();
    const day = today.getDate();
    const curYear = today.getFullYear();
    const curMonth = today.getMonth() + 1; // 1-indexed

    // Build 7 ranges: current + 6 previous months
    const ranges = [];
    for (let i = 6; i >= 0; i--) {
      let endMonth = curMonth - i;
      let endYear = curYear;
      if (endMonth < 1) { endMonth += 12; endYear -= 1; }
      const daysInEnd = new Date(endYear, endMonth, 0).getDate();
      const endDay = Math.min(day, daysInEnd);

      let startMonth = curMonth - i - 1;
      let startYear = curYear;
      if (startMonth < 1) { startMonth += 12; startYear -= 1; }
      const daysInStart = new Date(startYear, startMonth, 0).getDate();
      const startDay = Math.min(26, daysInStart);

      const start = `${startYear}-${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`;
      const end   = `${endYear}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;

      ranges.push({ idx: i, start, end, label: `${endYear}-${String(endMonth).padStart(2, "0")}` });
    }

    // Parallel queries — each range separately (avoids complex CASE WHEN binding issues)
    const queries = ranges.map((r) =>
      safeQuery(
        `SELECT COUNT(*) AS total FROM tr_complaint WHERE DATE(submitted_at) >= ? AND DATE(submitted_at) <= ?`,
        [r.start, r.end]
      )
    );
    const results = await Promise.all(queries);

    const data = ranges.map((r, i) => ({
      start: r.start,
      end: r.end,
      label: r.label,
      total: Number(results[i][0][0]?.total || 0),
    }));

    res.json({ data, today: today.toISOString() });
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
    if (req.query.category_id) { where.push("c.category_id = ?"); params.push(Number(req.query.category_id)); }
    if (req.query.topic_id) { where.push("c.topic_id = ?"); params.push(Number(req.query.topic_id)); }
    if (req.query.search) {
      where.push("(c.complaint_name LIKE ? OR c.nota_number LIKE ?)");
      const s = `%${req.query.search}%`;
      params.push(s, s);
    }
    if (req.query.start_date) { where.push("DATE(c.submitted_at) >= ?"); params.push(req.query.start_date); }
    if (req.query.end_date) { where.push("DATE(c.submitted_at) <= ?"); params.push(req.query.end_date); }

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
         c.progress, c.submitted_at, c.created_at, c.updated_at
       FROM tr_complaint c
       LEFT JOIN mst_outlet           o  ON o.id         = c.outlet_id
       LEFT JOIN mst_complaint_type   ct ON ct.type_id   = c.type_id
       LEFT JOIN mst_complaint_category cc ON cc.category_id = c.category_id
       LEFT JOIN mst_complaint_topic  cp ON cp.topic_id  = c.topic_id
       ${whereClause}
       ORDER BY c.submitted_at ${orderDir}
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
    const submittedAt = (req.body.submitted_at && req.body.submitted_at !== "null" && req.body.submitted_at !== "") ? req.body.submitted_at : null;

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
        submittedAt,
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
         (complaint_id, progress, note, pic_employee_id, pic_name, logged_by_user_id, logged_by_employee_id, logged_at)
       VALUES (?,?,?,?,?,?,?,COALESCE(?, NOW()))`,
      [complaintId, "Open", "Komplain dibuat.", picEmployeeId, picName,
        Number(userId), req.session?.employeeId ? Number(req.session.employeeId) : null, submittedAt]
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
    const submittedAt = (req.body.submitted_at && req.body.submitted_at !== "null" && req.body.submitted_at !== "") ? req.body.submitted_at : null;

    if (!typeId || !categoryId || !topicId || !outletId || !name || !nota || !description) {
      return res.status(400).json({ message: "Semua field wajib diisi." });
    }

    await safeQuery(
      `UPDATE tr_complaint SET
         type_id=?, category_id=?, topic_id=?, outlet_id=?,
         complaint_name=?, nota_number=?, qty=?, description=?,
         deduction=?, pic_employee_id=?, pic_name=?,
         submitted_at=COALESCE(?, submitted_at),
         duration_to_resolve = IF(resolved_at IS NOT NULL, GREATEST(TIMESTAMPDIFF(MINUTE, COALESCE(?, submitted_at), resolved_at), 0), duration_to_resolve),
         duration_to_close = IF(closed_at IS NOT NULL, GREATEST(TIMESTAMPDIFF(MINUTE, COALESCE(?, submitted_at), closed_at), 0), duration_to_close),
         updated_at=NOW()
       WHERE complaint_id=?`,
      [typeId, categoryId, topicId, outletId, name, nota, qty, description,
        deduction, picEmployeeId, picName,
        submittedAt, submittedAt, submittedAt,
        id]
    );

    if (submittedAt) {
      await safeQuery(
        `UPDATE tr_complaint_progress_log 
         SET logged_at = ? 
         WHERE complaint_id = ? AND progress = 'Open' 
         ORDER BY logged_at ASC, log_id ASC 
         LIMIT 1`,
        [submittedAt, id]
      );
      await syncComplaintProgress(id);
    }

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

    const [existing] = await safeQuery("SELECT complaint_id FROM tr_complaint WHERE complaint_id=?", [id]);
    if (!existing.length) return res.status(404).json({ message: "Komplain tidak ditemukan." });

    const progress = req.body.progress;
    const validProgress = ["Open", "On Progress", "Waiting Customer", "Resolved", "Closed"];
    if (!validProgress.includes(progress)) {
      return res.status(400).json({ message: "Progress tidak valid." });
    }

    const note = String(req.body.note || "").trim() || null;
    const picEmployeeId = req.body.pic_employee_id ? Number(req.body.pic_employee_id) : null;
    const picName = String(req.body.pic_name || "").trim() || null;
    const loggedAt = (req.body.logged_at && req.body.logged_at !== "null" && req.body.logged_at !== "") ? req.body.logged_at : null;

    const [logResult] = await safeQuery(
      `INSERT INTO tr_complaint_progress_log
         (complaint_id, progress, note, pic_employee_id, pic_name, logged_by_user_id, logged_by_employee_id, logged_at)
       VALUES (?,?,?,?,?,?,?,COALESCE(?, NOW()))`,
      [id, progress, note, picEmployeeId, picName,
        Number(userId), req.session?.employeeId ? Number(req.session.employeeId) : null, loggedAt]
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

    // Sync complaint progress
    await syncComplaintProgress(id);

    res.status(201).json({ message: "Progress log berhasil ditambahkan.", log_id: logId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Update progress log ──────────────────────────────────────────────────────

export const updateProgressLog = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const logId = Number(req.params.logId);
    if (!logId) return res.status(400).json({ message: "Log ID tidak valid." });

    const [existing] = await safeQuery(
      "SELECT complaint_id FROM tr_complaint_progress_log WHERE log_id = ?",
      [logId]
    );
    if (!existing.length) return res.status(404).json({ message: "Log tidak ditemukan." });

    const complaintId = existing[0].complaint_id;

    const progress = req.body.progress;
    const validProgress = ["Open", "On Progress", "Waiting Customer", "Resolved", "Closed"];
    if (!validProgress.includes(progress)) {
      return res.status(400).json({ message: "Progress tidak valid." });
    }

    const note = String(req.body.note || "").trim() || null;
    const picName = String(req.body.pic_name || "").trim() || null;
    const loggedAt = (req.body.logged_at && req.body.logged_at !== "null" && req.body.logged_at !== "") ? req.body.logged_at : null;

    await safeQuery(
      `UPDATE tr_complaint_progress_log 
       SET progress = ?, note = ?, pic_name = ?, logged_at = COALESCE(?, logged_at)
       WHERE log_id = ?`,
      [progress, note, picName, loggedAt, logId]
    );

    // Sync complaint progress
    await syncComplaintProgress(complaintId);

    res.json({ message: "Progress log berhasil diupdate." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── Delete progress log ──────────────────────────────────────────────────────

export const deleteProgressLog = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const logId = Number(req.params.logId);
    if (!logId) return res.status(400).json({ message: "Log ID tidak valid." });

    const [existing] = await safeQuery(
      "SELECT complaint_id FROM tr_complaint_progress_log WHERE log_id = ?",
      [logId]
    );
    if (!existing.length) return res.status(404).json({ message: "Log tidak ditemukan." });

    const complaintId = existing[0].complaint_id;

    // Delete associated files
    const [pdocs] = await safeQuery(
      "SELECT file_path FROM tr_complaint_progress_document WHERE log_id = ?",
      [logId]
    );
    pdocs.forEach((d) => removeFile(d.file_path));

    // Delete database records
    await safeQuery("DELETE FROM tr_complaint_progress_log WHERE log_id = ?", [logId]);

    // Sync complaint progress
    await syncComplaintProgress(complaintId);

    res.json({ message: "Progress log berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

