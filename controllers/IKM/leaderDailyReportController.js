import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(__dirname, "..", "..", "assets");

const IKM_COMPANY_ID = 2;

function toISODateString(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
}
function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toUInt(v, def = 0) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : def;
}
function toBoolean(v) {
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "y"].includes(String(v || "").toLowerCase());
}
function resolveReportedBy(req) {
  return (
    req.session?.user?.employee?.employee_id ||
    req.session?.user?.employeeId ||
    req.session?.employeeId ||
    0
  );
}
function buildBriefingUrl(filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  const base = (process.env.IKM_PUBLIC_BASE_URL || "https://api.ikmalora.com").replace(/\/+$/, "");
  const name = path.basename(filename);
  return `${base}/storage/dailyreport/${name}`;
}

// ── GET employee options for dropdowns ────────────────────────────────────
export const getEmployeeOptions = async (req, res) => {
  try {
    const [employees] = await safeQuery(
      `SELECT e.employee_id, e.employee_code, e.full_name,
              p.position_name, j.job_level_name
       FROM mst_employee e
       LEFT JOIN mst_position p ON p.position_id = e.position_id
       LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
       WHERE e.is_deleted = 0 AND e.company_id = ?
       ORDER BY e.full_name ASC`,
      [IKM_COMPANY_ID]
    );
    res.json({ data: employees });
  } catch (err) {
    console.error("getEmployeeOptions:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET lookup data ────────────────────────────────────────────────────────
export const getDailyReportMeta = async (req, res) => {
  try {
    const [areas] = await safeIKMQuery("SELECT id, area_name FROM mst_area ORDER BY area_name ASC");
    res.json({ areas });
  } catch (err) {
    console.error("getDailyReportMeta:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET list ───────────────────────────────────────────────────────────────
export const getDailyReports = async (req, res) => {
  try {
    const { startDate, endDate, area_id, page, limit } = req.query;

    const start = toISODateString(startDate);
    const end   = toISODateString(endDate);
    const pg    = toPositiveInt(page) ?? 1;
    const lm    = Math.min(toPositiveInt(limit) ?? 25, 100);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (start) { where.push("dr.report_date >= ?"); params.push(start); }
    if (end)   { where.push("dr.report_date <= ?"); params.push(end); }
    if (area_id) { where.push("dr.area_id = ?"); params.push(Number(area_id)); }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total FROM tr_daily_report_leader dr ${whereSql}`,
      params
    );

    const [rows] = await safeIKMQuery(
      `SELECT dr.id, dr.report_date, dr.area_id, a.area_name,
              dr.pic_name, dr.role, dr.present_count, dr.production_start_time,
              dr.is_late, dr.area_cleanliness, dr.constraint_notes,
              dr.briefing_doc_path, dr.reported_by, dr.created_at
       FROM tr_daily_report_leader dr
       LEFT JOIN mst_area a ON a.id = dr.area_id
       ${whereSql}
       ORDER BY dr.report_date DESC, dr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    if (!rows.length) {
      const [areas] = await safeIKMQuery("SELECT id, area_name FROM mst_area ORDER BY area_name ASC");
      return res.json({
        data: [],
        pagination: { page: pg, limit: lm, total: 0, totalPages: 0 },
        areas,
      });
    }

    // Fetch absent + late sub-records for the returned reports
    const reportIds = rows.map((r) => r.id);
    const idPh = reportIds.map(() => "?").join(",");

    const [absentRows] = await safeIKMQuery(
      `SELECT report_id, employee_id, absence_reason
       FROM tr_daily_report_absent WHERE report_id IN (${idPh})`,
      reportIds
    );
    const [lateRows] = await safeIKMQuery(
      `SELECT report_id, employee_id, late_time
       FROM tr_daily_report_late WHERE report_id IN (${idPh})`,
      reportIds
    );

    // Enrich employee info
    const allEmpIds = [
      ...new Set([
        ...absentRows.map((r) => r.employee_id),
        ...lateRows.map((r) => r.employee_id),
        ...rows.map((r) => r.reported_by).filter(Boolean),
      ]),
    ].filter(Boolean);

    let employeeMap = new Map();
    if (allEmpIds.length) {
      const ph = allEmpIds.map(() => "?").join(",");
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`,
        allEmpIds
      );
      emps.forEach((e) => employeeMap.set(e.employee_id, e.full_name));
    }

    // Group absent/late by report_id
    const absentMap = new Map();
    absentRows.forEach((r) => {
      if (!absentMap.has(r.report_id)) absentMap.set(r.report_id, []);
      absentMap.get(r.report_id).push({
        employee_id: r.employee_id,
        absence_reason: r.absence_reason,
        full_name: employeeMap.get(r.employee_id) || null,
      });
    });

    const lateMap = new Map();
    lateRows.forEach((r) => {
      if (!lateMap.has(r.report_id)) lateMap.set(r.report_id, []);
      lateMap.get(r.report_id).push({
        employee_id: r.employee_id,
        late_time: r.late_time,
        full_name: employeeMap.get(r.employee_id) || null,
      });
    });

    const records = rows.map((r) => ({
      ...r,
      is_late: Boolean(r.is_late),
      briefing_doc_url: buildBriefingUrl(r.briefing_doc_path),
      reporter_employee_name: employeeMap.get(r.reported_by) || null,
      absent_employees: absentMap.get(r.id) || [],
      late_employees: lateMap.get(r.id) || [],
    }));

    const [areas] = await safeIKMQuery("SELECT id, area_name FROM mst_area ORDER BY area_name ASC");

    res.json({
      data: records,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      areas,
    });
  } catch (err) {
    console.error("getDailyReports:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST create ────────────────────────────────────────────────────────────
export const createDailyReport = async (req, res) => {
  try {
    const {
      report_date, area_id, pic_name, role, present_count,
      production_start_time, is_late, area_cleanliness, constraint_notes,
      absent_employees, late_employees,
    } = req.body;

    const date = toISODateString(report_date);
    if (!date) return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    if (!toPositiveInt(area_id)) return res.status(400).json({ message: "Area wajib dipilih" });
    if (!pic_name?.trim()) return res.status(400).json({ message: "Nama PIC wajib diisi" });
    if (!["Leader", "Deputi"].includes(role)) return res.status(400).json({ message: "Role tidak valid" });
    if (!production_start_time?.trim()) return res.status(400).json({ message: "Jam mulai produksi wajib diisi" });
    if (!["Bersih", "Kotor"].includes(area_cleanliness)) return res.status(400).json({ message: "Status kebersihan tidak valid" });

    const reportedBy = resolveReportedBy(req);
    const briefingFilename = req.file ? req.file.filename : null;

    const [result] = await safeIKMQuery(
      `INSERT INTO tr_daily_report_leader
         (report_date, area_id, pic_name, role, present_count, production_start_time,
          is_late, area_cleanliness, constraint_notes, briefing_doc_path, reported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        date, Number(area_id), pic_name.trim(), role,
        toUInt(present_count, 0), production_start_time.trim(),
        toBoolean(is_late) ? 1 : 0,
        area_cleanliness, constraint_notes?.trim() || null,
        briefingFilename, reportedBy,
      ]
    );

    const reportId = result.insertId;

    // Insert absent employees
    const absentList = parseJsonArray(absent_employees);
    if (absentList.length) {
      const absentValues = absentList
        .filter((a) => a.employee_id && a.absence_reason)
        .map((a) => [reportId, Number(a.employee_id), a.absence_reason]);
      if (absentValues.length) {
        await safeIKMQuery(
          `INSERT INTO tr_daily_report_absent (report_id, employee_id, absence_reason) VALUES ?`,
          [absentValues]
        );
      }
    }

    // Insert late employees
    const lateList = parseJsonArray(late_employees);
    if (lateList.length) {
      const lateValues = lateList
        .filter((l) => l.employee_id && l.late_time)
        .map((l) => [reportId, Number(l.employee_id), l.late_time]);
      if (lateValues.length) {
        await safeIKMQuery(
          `INSERT INTO tr_daily_report_late (report_id, employee_id, late_time) VALUES ?`,
          [lateValues]
        );
      }
    }

    res.status(201).json({ message: "Laporan harian berhasil ditambahkan", id: reportId });
  } catch (err) {
    console.error("createDailyReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT update ─────────────────────────────────────────────────────────────
export const updateDailyReport = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, briefing_doc_path FROM tr_daily_report_leader WHERE id = ?", [id]
    );
    if (!exist.length) return res.status(404).json({ message: "Laporan tidak ditemukan" });

    const current = exist[0];
    const {
      report_date, area_id, pic_name, role, present_count,
      production_start_time, is_late, area_cleanliness, constraint_notes,
      absent_employees, late_employees,
    } = req.body;

    const date = toISODateString(report_date);
    if (!date) return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    if (!["Leader", "Deputi"].includes(role)) return res.status(400).json({ message: "Role tidak valid" });
    if (!["Bersih", "Kotor"].includes(area_cleanliness)) return res.status(400).json({ message: "Status kebersihan tidak valid" });

    let briefingFilename = current.briefing_doc_path;
    if (req.file) {
      if (current.briefing_doc_path) {
        const oldPath = path.join(BASE_DIR, "ikm_briefing", current.briefing_doc_path);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      briefingFilename = req.file.filename;
    }

    await safeIKMQuery(
      `UPDATE tr_daily_report_leader
       SET report_date=?, area_id=?, pic_name=?, role=?, present_count=?,
           production_start_time=?, is_late=?, area_cleanliness=?,
           constraint_notes=?, briefing_doc_path=?, updated_at=NOW()
       WHERE id=?`,
      [
        date, Number(area_id), pic_name?.trim(), role,
        toUInt(present_count, 0), production_start_time?.trim(),
        toBoolean(is_late) ? 1 : 0,
        area_cleanliness, constraint_notes?.trim() || null,
        briefingFilename, id,
      ]
    );

    // Replace absent employees
    await safeIKMQuery("DELETE FROM tr_daily_report_absent WHERE report_id = ?", [id]);
    const absentList = parseJsonArray(absent_employees);
    if (absentList.length) {
      const absentValues = absentList
        .filter((a) => a.employee_id && a.absence_reason)
        .map((a) => [Number(id), Number(a.employee_id), a.absence_reason]);
      if (absentValues.length) {
        await safeIKMQuery(
          `INSERT INTO tr_daily_report_absent (report_id, employee_id, absence_reason) VALUES ?`,
          [absentValues]
        );
      }
    }

    // Replace late employees
    await safeIKMQuery("DELETE FROM tr_daily_report_late WHERE report_id = ?", [id]);
    const lateList = parseJsonArray(late_employees);
    if (lateList.length) {
      const lateValues = lateList
        .filter((l) => l.employee_id && l.late_time)
        .map((l) => [Number(id), Number(l.employee_id), l.late_time]);
      if (lateValues.length) {
        await safeIKMQuery(
          `INSERT INTO tr_daily_report_late (report_id, employee_id, late_time) VALUES ?`,
          [lateValues]
        );
      }
    }

    res.json({ message: "Laporan harian berhasil diperbarui" });
  } catch (err) {
    console.error("updateDailyReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE ─────────────────────────────────────────────────────────────────
export const deleteDailyReport = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, briefing_doc_path FROM tr_daily_report_leader WHERE id = ?", [id]
    );
    if (!exist.length) return res.status(404).json({ message: "Laporan tidak ditemukan" });

    const { briefing_doc_path } = exist[0];
    if (briefing_doc_path) {
      const filePath = path.join(BASE_DIR, "ikm_briefing", briefing_doc_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    // FK cascade handles absent + late rows
    await safeIKMQuery("DELETE FROM tr_daily_report_leader WHERE id = ?", [id]);
    res.json({ message: "Laporan harian berhasil dihapus" });
  } catch (err) {
    console.error("deleteDailyReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── helper ─────────────────────────────────────────────────────────────────
function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value); } catch { return []; }
}
