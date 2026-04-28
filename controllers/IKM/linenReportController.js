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
function resolveReportedBy(req) {
  return (
    req.session?.user?.employee?.employee_id ||
    req.session?.user?.employeeId ||
    req.session?.employeeId ||
    0
  );
}

function buildAttachmentUrl(filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  const base = (process.env.IKM_PUBLIC_BASE_URL || "https://api.ikmalora.com").replace(/\/+$/, "");
  const name = path.basename(filename);
  return `${base}/storage/linenreport/${name}`;
}

// ── GET list ───────────────────────────────────────────────────────────────
export const getLinenReports = async (req, res) => {
  try {
    const { startDate, endDate, area_id, hospital_id, finding_location, page, limit } = req.query;

    const start = toISODateString(startDate);
    const end   = toISODateString(endDate);
    const pg    = toPositiveInt(page) ?? 1;
    const lm    = Math.min(toPositiveInt(limit) ?? 25, 100);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (start) { where.push("lr.report_date >= ?"); params.push(start); }
    if (end)   { where.push("lr.report_date <= ?"); params.push(end); }
    if (area_id) { where.push("lr.area_id = ?"); params.push(Number(area_id)); }
    if (hospital_id) { where.push("lr.hospital_id = ?"); params.push(Number(hospital_id)); }
    if (finding_location && ["Rumah Sakit", "IKM"].includes(finding_location)) {
      where.push("lr.finding_location = ?");
      params.push(finding_location);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total
       FROM tr_linen_report lr
       ${whereSql}`,
      params
    );

    const [rows] = await safeIKMQuery(
      `SELECT lr.id, lr.reporter_name, lr.report_date, lr.area_id,
              a.area_name, lr.hospital_id, h.hospital_name,
              lr.finding_location, lr.linen_type, lr.finding_type,
              lr.finding_qty, lr.attachment_path, lr.reported_by, lr.created_at
       FROM tr_linen_report lr
       LEFT JOIN mst_area a ON a.id = lr.area_id
       LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
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
      reporter_employee_name: employeeMap.get(r.reported_by) || null,
    }));

    // fetch lookup lists for filters
    const [areas] = await safeIKMQuery(
      "SELECT id, area_name FROM mst_area ORDER BY area_name ASC"
    );
    const [hospitals] = await safeIKMQuery(
      "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
    );

    res.json({
      data: records,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      areas,
      hospitals,
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
    res.json({ areas, hospitals });
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
      finding_location, linen_type, finding_type, finding_qty,
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
          linen_type, finding_type, finding_qty, attachment_path, reported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reporter_name.trim(), date, Number(area_id), Number(hospital_id),
        finding_location, linen_type.trim(), finding_type.trim(),
        qty, attachmentFilename, reportedBy,
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
      finding_location, linen_type, finding_type, finding_qty,
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
           finding_location=?, linen_type=?, finding_type=?, finding_qty=?,
           attachment_path=?, updated_at=NOW()
       WHERE id=?`,
      [
        reporter_name.trim(), date, Number(area_id), Number(hospital_id),
        finding_location, linen_type?.trim(), finding_type?.trim(),
        toUInt(finding_qty, 1), attachmentFilename, id,
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
