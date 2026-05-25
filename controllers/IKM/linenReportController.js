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

function getDefaultCutoffDates() {
  const now = new Date();
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

// ── GET list ───────────────────────────────────────────────────────────────
export const getLinenReports = async (req, res) => {
  try {
    const { startDate, endDate, area_id, hospital_id, finding_location, search, page, limit } = req.query;

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
    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push(
        "(lr.reporter_name LIKE ? OR lr.linen_type LIKE ? OR lr.finding_type LIKE ?" +
        " OR h.hospital_name LIKE ? OR a.area_name LIKE ? OR lr.finding_location LIKE ? OR lr.status LIKE ?)"
      );
      params.push(like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total
       FROM tr_linen_report lr
       LEFT JOIN mst_area a ON a.id = lr.area_id
       LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
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
              lr.completed_by, lr.completed_by_name, lr.completed_note, lr.completed_path, lr.completed_at
       FROM tr_linen_report lr
       LEFT JOIN mst_area a ON a.id = lr.area_id
       LEFT JOIN mst_hospital h ON h.id = lr.hospital_id
       ${whereSql}
       ORDER BY lr.report_date DESC, lr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    // NOTE: COUNT query also needs LEFT JOIN for hospital search to work
    // Re-running count with joins when search is active is handled above via whereSql

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
