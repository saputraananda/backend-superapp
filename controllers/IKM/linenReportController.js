import path from "path";
import { wibNow } from "../../utils/timeWIB.js";
import fs from "fs";
import { fileURLToPath } from "url";
import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(__dirname, "..", "..", "assets");

function toISODateString(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
}
function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function toUInt(v, def = 1) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

function getDefaultCutoffDates() {
  const now = wibNow();
  const day = now.getDate();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  let start, end;
  if (day <= 25) {
    const s = new Date(year, month - 1, 26);
    const e = new Date(year, month, 25);
    start = `${s.getFullYear()}-${String(s.getMonth()+1).padStart(2,"0")}-26`;
    end   = `${e.getFullYear()}-${String(e.getMonth()+1).padStart(2,"0")}-25`;
  } else {
    const s = new Date(year, month, 26);
    const e = new Date(year, month + 1, 25);
    start = `${s.getFullYear()}-${String(s.getMonth()+1).padStart(2,"0")}-26`;
    end   = `${e.getFullYear()}-${String(e.getMonth()+1).padStart(2,"0")}-25`;
  }
  return { start, end };
}

function resolveReportedBy(req) {
  return (
    req.session?.user?.employee?.employee_id ||
    req.session?.user?.employeeId ||
    req.session?.employeeId ||
    0
  );
}

function resolveCurrentUser(req) {
  const emp = req.session?.user?.employee;
  const id = emp?.employee_id || req.session?.user?.employeeId || req.session?.employeeId || 0;
  const name = emp?.full_name || req.session?.user?.name || "";
  return { id, name };
}

function buildAttachmentUrl(filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  const base = (process.env.IKM_PUBLIC_BASE_URL || "https://api.ikmalora.com").replace(/\/+$/, "");
  const name = path.basename(filename);
  return `${base}/storage/linenreport/${name}`;
}

// ── GET dashboard — agregat laporan linen untuk periode & filter terpilih ───
function shiftISODate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const getLinenReportDashboard = async (req, res) => {
  try {
    const { startDate, endDate, area_id, hospital_id, finding_location, floor } = req.query;

    const defaultCutoff = getDefaultCutoffDates();
    let start = toISODateString(startDate) || defaultCutoff.start;
    let end   = toISODateString(endDate)   || defaultCutoff.end;
    if (start > end) [start, end] = [end, start];

    // Periode pembanding: rentang sama panjang tepat sebelum periode aktif
    const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    const prevEnd = shiftISODate(start, -1);
    const prevStart = shiftISODate(prevEnd, -(spanDays - 1));

    const buildWhere = (from, to) => {
      const where = ["lr.report_date >= ?", "lr.report_date <= ?"];
      const params = [from, to];
      if (toPositiveInt(area_id)) { where.push("lr.area_id = ?"); params.push(toPositiveInt(area_id)); }
      if (toPositiveInt(hospital_id)) { where.push("lr.hospital_id = ?"); params.push(toPositiveInt(hospital_id)); }
      if (finding_location && ["Rumah Sakit", "IKM"].includes(finding_location)) {
        where.push("lr.finding_location = ?");
        params.push(finding_location);
      }
      if (floor) { where.push("f.floor = ?"); params.push(floor); }
      return { whereSql: `WHERE ${where.join(" AND ")}`, params };
    };

    const FROM = `
      FROM tr_linen_report lr
      LEFT JOIN mst_area a ON a.id = lr.area_id
      LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
      LEFT JOIN mst_floor f ON f.employee_id = lr.reported_by`;

    const cur = buildWhere(start, end);
    const prev = buildWhere(prevStart, prevEnd);

    const totalsSql = (whereSql) => `
      SELECT COUNT(*) AS reports,
             COALESCE(SUM(lr.finding_qty), 0) AS total_qty,
             COALESCE(SUM(lr.status = 'terkirim'), 0) AS sent,
             COALESCE(SUM(lr.status = 'proses'), 0) AS processing,
             COALESCE(SUM(lr.status = 'selesai'), 0) AS done,
             AVG(CASE WHEN lr.status = 'selesai' AND lr.completed_at IS NOT NULL
                      THEN TIMESTAMPDIFF(MINUTE, lr.created_at, lr.completed_at) END) AS avg_minutes
      ${FROM}
      ${whereSql}`;

    // Agregat per dimensi: laporan & qty. `dimSql` = ekspresi kolom pengelompokan.
    const groupSql = (dimSql, extraWhere = "") => `
      SELECT ${dimSql} AS name, COUNT(*) AS reports, COALESCE(SUM(lr.finding_qty), 0) AS qty
      ${FROM}
      ${cur.whereSql} ${extraWhere}
      GROUP BY name
      ORDER BY reports DESC, qty DESC
      LIMIT 8`;

    const [
      [[totals]],
      [[prevTotals]],
      [trend],
      [byFinding],
      [byLinen],
      [byLocation],
      [byOwnership],
      [byHospital],
      [byArea],
      [byFloor],
      [attention],
    ] = await Promise.all([
      safeIKMQuery(totalsSql(cur.whereSql), cur.params),
      safeIKMQuery(totalsSql(prev.whereSql), prev.params),
      safeIKMQuery(
        `SELECT DATE_FORMAT(lr.report_date, '%Y-%m-%d') AS date,
                COUNT(*) AS reports, COALESCE(SUM(lr.finding_qty), 0) AS qty
         ${FROM}
         ${cur.whereSql}
         GROUP BY lr.report_date
         ORDER BY lr.report_date ASC`,
        cur.params
      ),
      safeIKMQuery(groupSql("lr.finding_type"), cur.params),
      safeIKMQuery(groupSql("lr.linen_type"), cur.params),
      safeIKMQuery(
        `SELECT lr.finding_location AS name, COUNT(*) AS reports, COALESCE(SUM(lr.finding_qty), 0) AS qty
         ${FROM} ${cur.whereSql} GROUP BY lr.finding_location`,
        cur.params
      ),
      safeIKMQuery(
        `SELECT lr.ownership_type AS name, COUNT(*) AS reports, COALESCE(SUM(lr.finding_qty), 0) AS qty
         ${FROM} ${cur.whereSql} GROUP BY lr.ownership_type`,
        cur.params
      ),
      safeIKMQuery(groupSql("h.hospital_name"), cur.params),
      safeIKMQuery(groupSql("a.area_name"), cur.params),
      safeIKMQuery(groupSql("f.floor", "AND f.floor IS NOT NULL AND f.floor != ''"), cur.params),
      safeIKMQuery(
        `SELECT lr.id, DATE_FORMAT(lr.report_date, '%Y-%m-%d') AS report_date,
                h.hospital_name, a.area_name, lr.linen_type, lr.finding_type,
                lr.finding_qty, lr.status,
                DATEDIFF(CURDATE(), lr.report_date) AS age_days
         ${FROM}
         ${cur.whereSql} AND lr.status <> 'selesai'
         ORDER BY lr.report_date ASC, lr.id ASC
         LIMIT 10`,
        cur.params
      ),
    ]);

    const summarize = (t) => ({
      reports: Number(t?.reports || 0),
      totalQty: Number(t?.total_qty || 0),
      sent: Number(t?.sent || 0),
      processing: Number(t?.processing || 0),
      done: Number(t?.done || 0),
      avgMinutes: t?.avg_minutes == null ? null : Math.round(Number(t.avg_minutes)),
    });
    const rows = (list, fallback = "-") =>
      list.map((r) => ({ name: r.name || fallback, reports: Number(r.reports), qty: Number(r.qty) }));

    res.json({
      period: { startDate: start, endDate: end, prevStartDate: prevStart, prevEndDate: prevEnd },
      summary: summarize(totals),
      previous: summarize(prevTotals),
      trend: trend.map((r) => ({ date: r.date, reports: Number(r.reports), qty: Number(r.qty) })),
      byFinding: rows(byFinding),
      byLinen: rows(byLinen),
      byLocation: rows(byLocation),
      byOwnership: byOwnership.map((r) => ({
        key: r.name === "rental" ? "SEWA" : r.name === "hospital" ? "RS" : "NONE",
        reports: Number(r.reports),
        qty: Number(r.qty),
      })),
      byHospital: rows(byHospital),
      byArea: rows(byArea),
      byFloor: rows(byFloor),
      attention: attention.map((r) => ({
        id: r.id,
        report_date: r.report_date,
        hospital_name: r.hospital_name || "-",
        area_name: r.area_name || "-",
        linen_type: r.linen_type,
        finding_type: r.finding_type,
        qty: Number(r.finding_qty),
        status: r.status,
        age_days: Math.max(0, Number(r.age_days) || 0),
      })),
    });
  } catch (err) {
    console.error("getLinenReportDashboard error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET list ───────────────────────────────────────────────────────────────
export const getLinenReports = async (req, res) => {
  try {
    const { startDate, endDate, area_id, hospital_id, finding_location, floor, status, search, page, limit } = req.query;

    const defaultCutoff = getDefaultCutoffDates();
    const start = toISODateString(startDate) || defaultCutoff.start;
    const end   = toISODateString(endDate)   || defaultCutoff.end;
    const pg    = toPositiveInt(page) ?? 1;
    const lm    = Math.min(toPositiveInt(limit) ?? 25, 100);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    where.push("lr.report_date >= ?"); params.push(start);
    where.push("lr.report_date <= ?"); params.push(end);
    if (area_id) { where.push("lr.area_id = ?"); params.push(Number(area_id)); }
    if (hospital_id) { where.push("lr.hospital_id = ?"); params.push(Number(hospital_id)); }
    if (finding_location && ["Rumah Sakit", "IKM"].includes(finding_location)) {
      where.push("lr.finding_location = ?");
      params.push(finding_location);
    }
    if (floor) {
      where.push("f.floor = ?");
      params.push(floor);
    }
    if (status && ["terkirim", "proses", "selesai"].includes(status)) {
      where.push("lr.status = ?");
      params.push(status);
    }
    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push(
        "(lr.reporter_name LIKE ? OR lr.linen_type LIKE ? OR lr.finding_type LIKE ?" +
        " OR h.hospital_name LIKE ? OR a.area_name LIKE ? OR lr.finding_location LIKE ? OR lr.status LIKE ? OR f.floor LIKE ?)"
      );
      params.push(like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total
       FROM tr_linen_report lr
       LEFT JOIN mst_area a ON a.id = lr.area_id
       LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
       LEFT JOIN mst_floor f ON f.employee_id = lr.reported_by
       ${whereSql}`,
      params
    );

    const [rows] = await safeIKMQuery(
      `SELECT lr.id, lr.reporter_name, lr.report_date, lr.area_id,
              a.area_name, lr.hospital_id, h.hospital_name,
              lr.finding_location, lr.linen_type, lr.ownership_type, lr.finding_type,
              lr.finding_qty, lr.attachment_path, lr.reported_by, lr.created_at,
              lr.status, lr.sending_note,
              lr.process_by, lr.process_by_name, lr.process_note, lr.process_path, lr.process_at,
              lr.completed_by, lr.completed_by_name, lr.completed_note, lr.completed_path, lr.completed_at,
              f.floor
       FROM tr_linen_report lr
       LEFT JOIN mst_area a ON a.id = lr.area_id
       LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
       LEFT JOIN mst_floor f ON f.employee_id = lr.reported_by
       ${whereSql}
       ORDER BY lr.report_date DESC, lr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    // enrich reported_by with employee name
    const reportedByIds = [...new Set(rows.map((r) => r.reported_by).filter(Boolean))];
    let employeeMap = new Map();
    if (reportedByIds.length) {
      const ph = reportedByIds.map(() => "?").join(",");
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`,
        reportedByIds
      );
      emps.forEach((e) => employeeMap.set(e.employee_id, e.full_name));
    }

    const records = rows.map((r) => ({
      ...r,
      attachment_url: buildAttachmentUrl(r.attachment_path),
      process_path_url: buildAttachmentUrl(r.process_path),
      completed_path_url: buildAttachmentUrl(r.completed_path),
      reporter_employee_name: employeeMap.get(r.reported_by) || null,
    }));

    // fetch lookup lists for filters
    const [areas] = await safeIKMQuery(
      "SELECT id, area_name FROM mst_area ORDER BY area_name ASC"
    );
    const [hospitals] = await safeIKMQuery(
      "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
    );
    const [floors] = await safeIKMQuery(
      "SELECT DISTINCT floor FROM mst_floor WHERE floor IS NOT NULL AND floor != '' ORDER BY floor ASC"
    );

    res.json({
      data: records,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      areas,
      hospitals,
      floors,
    });
  } catch (err) {
    console.error("getLinenReports:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET lookup data (areas + hospitals) ───────────────────────────────────
export const getLinenReportMeta = async (req, res) => {
  try {
    const [areas] = await safeIKMQuery("SELECT id, area_name FROM mst_area ORDER BY area_name ASC");
    const [hospitals] = await safeIKMQuery("SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC");
    const [floors] = await safeIKMQuery("SELECT DISTINCT floor FROM mst_floor WHERE floor IS NOT NULL AND floor != '' ORDER BY floor ASC");
    res.json({ areas, hospitals, floors });
  } catch (err) {
    console.error("getLinenReportMeta:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST create ────────────────────────────────────────────────────────────
export const createLinenReport = async (req, res) => {
  try {
    const {
      reporter_name, report_date, area_id, hospital_id,
      finding_location, linen_type, ownership_type, finding_type, finding_qty, sending_note,
    } = req.body;

    if (!reporter_name?.trim())
      return res.status(400).json({ message: "Nama pelapor wajib diisi" });
    const date = toISODateString(report_date);
    if (!date)
      return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    if (!toPositiveInt(area_id))
      return res.status(400).json({ message: "Area wajib dipilih" });
    if (!toPositiveInt(hospital_id))
      return res.status(400).json({ message: "Rumah sakit wajib dipilih" });
    if (!["Rumah Sakit", "IKM"].includes(finding_location))
      return res.status(400).json({ message: "Lokasi temuan tidak valid" });
    if (!linen_type?.trim())
      return res.status(400).json({ message: "Jenis linen wajib diisi" });
    if (!finding_type?.trim())
      return res.status(400).json({ message: "Jenis temuan wajib diisi" });

    const qty = toUInt(finding_qty, 1);
    const reportedBy = resolveReportedBy(req);
    const attachmentFilename = req.file ? req.file.filename : null;

    const [result] = await safeIKMQuery(
      `INSERT INTO tr_linen_report
         (reporter_name, report_date, area_id, hospital_id, finding_location,
          linen_type, ownership_type, finding_type, finding_qty, attachment_path, reported_by, sending_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reporter_name.trim(), date, Number(area_id), Number(hospital_id),
        finding_location, linen_type.trim(), ownership_type || null, finding_type.trim(),
        qty, attachmentFilename, reportedBy,
        sending_note?.trim() || null,
      ]
    );

    res.status(201).json({ message: "Laporan linen berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createLinenReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT update ─────────────────────────────────────────────────────────────
export const updateLinenReport = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, attachment_path FROM tr_linen_report WHERE id = ?", [id]
    );
    if (!exist.length)
      return res.status(404).json({ message: "Laporan tidak ditemukan" });

    const current = exist[0];
    const {
      reporter_name, report_date, area_id, hospital_id,
      finding_location, linen_type, ownership_type, finding_type, finding_qty, sending_note,
    } = req.body;

    if (!reporter_name?.trim())
      return res.status(400).json({ message: "Nama pelapor wajib diisi" });
    const date = toISODateString(report_date);
    if (!date)
      return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    if (!["Rumah Sakit", "IKM"].includes(finding_location))
      return res.status(400).json({ message: "Lokasi temuan tidak valid" });

    // if new file uploaded, delete old one
    let attachmentFilename = current.attachment_path;
    if (req.file) {
      if (current.attachment_path) {
        const oldPath = path.join(BASE_DIR, "ikm_linen", current.attachment_path);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      attachmentFilename = req.file.filename;
    }

    await safeIKMQuery(
      `UPDATE tr_linen_report
       SET reporter_name=?, report_date=?, area_id=?, hospital_id=?,
           finding_location=?, linen_type=?, ownership_type=?, finding_type=?, finding_qty=?,
           attachment_path=?, sending_note=?, updated_at=NOW()
       WHERE id=?`,
      [
        reporter_name.trim(), date, Number(area_id), Number(hospital_id),
        finding_location, linen_type?.trim(), ownership_type || null, finding_type?.trim(),
        toUInt(finding_qty, 1), attachmentFilename, sending_note?.trim() || null, id,
      ]
    );

    res.json({ message: "Laporan linen berhasil diperbarui" });
  } catch (err) {
    console.error("updateLinenReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE ─────────────────────────────────────────────────────────────────
export const deleteLinenReport = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, attachment_path FROM tr_linen_report WHERE id = ?", [id]
    );
    if (!exist.length)
      return res.status(404).json({ message: "Laporan tidak ditemukan" });

    const { attachment_path } = exist[0];
    if (attachment_path) {
      const filePath = path.join(BASE_DIR, "ikm_linen", attachment_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await safeIKMQuery("DELETE FROM tr_linen_report WHERE id = ?", [id]);
    res.json({ message: "Laporan linen berhasil dihapus" });
  } catch (err) {
    console.error("deleteLinenReport:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT update status (proses / selesai) ────────────────────────────────────
export const updateLinenReportStatus = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, status FROM tr_linen_report WHERE id = ?", [id]
    );
    if (!exist.length)
      return res.status(404).json({ message: "Laporan tidak ditemukan" });

    const current = exist[0];
    const { status, note, by_name } = req.body;
    const user = resolveCurrentUser(req);
    const actorName = by_name?.trim() || user.name;

    if (!["proses", "selesai"].includes(status))
      return res.status(400).json({ message: "Status hanya boleh 'proses' atau 'selesai'" });

    const attachmentFilename = req.file ? req.file.filename : null;

    if (status === "proses") {
      if (current.status !== "terkirim")
        return res.status(400).json({ message: "Hanya laporan dengan status 'terkirim' yang dapat diproses" });

      await safeIKMQuery(
        `UPDATE tr_linen_report
         SET status='proses', process_by=?, process_by_name=?, process_note=?,
             process_path=COALESCE(?, process_path), process_at=NOW()
         WHERE id=?`,
        [user.id, actorName, note?.trim() || null, attachmentFilename, id]
      );
      res.json({ message: "Laporan diproses", status: "proses" });
    } else if (status === "selesai") {
      if (current.status !== "proses" && current.status !== "terkirim")
        return res.status(400).json({ message: "Status tidak valid untuk diselesaikan" });

      await safeIKMQuery(
        `UPDATE tr_linen_report
         SET status='selesai', completed_by=?, completed_by_name=?, completed_note=?,
             completed_path=COALESCE(?, completed_path), completed_at=NOW()
         WHERE id=?`,
        [user.id, actorName, note?.trim() || null, attachmentFilename, id]
      );
      res.json({ message: "Laporan diselesaikan", status: "selesai" });
    }
  } catch (err) {
    console.error("updateLinenReportStatus:", err);
    res.status(500).json({ message: err.message });
  }
};
