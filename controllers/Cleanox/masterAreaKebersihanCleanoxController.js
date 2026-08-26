import fs from "fs";
import path from "path";
import { pool, cleanoxPool, safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_KEBERSIHAN_DIR } from "../../middleware/upload.js";

const VALID_SCORES = [0, 0.5, 1];

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function normalizeScore(value) {
  const n = Number(value);
  if (n === 0 || n === 0.5 || n === 1) return n;
  return null;
}

function reviewStatusFromCount(count, required = 4) {
  const n = Number(count) || 0;
  if (n <= 0) return "belum";
  if (n >= required) return "selesai";
  return "sebagian";
}

async function getCleanoxRoleMap() {
  const [roleRows] = await safeCleanoxQuery("SELECT employee_id, role FROM mst_role");
  const roleMap = {};
  for (const rr of roleRows || []) {
    roleMap[Number(rr.employee_id)] = rr.role;
  }
  return roleMap;
}

async function assertCleanoxCompany3Employee(employeeId) {
  const id = Number(employeeId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const roleMap = await getCleanoxRoleMap();
  if (!roleMap[id]) return null;

  const [rows] = await safeQuery(
    `SELECT
      e.employee_id,
      e.employee_code,
      e.full_name,
      e.email,
      e.phone_number,
      e.company_id,
      u.username
     FROM mst_employee e
     LEFT JOIN users u ON u.email = e.email
     WHERE e.employee_id = ?
       AND e.company_id = 3
       AND e.is_deleted = 0
     LIMIT 1`,
    [id],
  );

  if (!rows.length) return null;
  return {
    ...rows[0],
    cleanox_role: roleMap[id] ?? null,
  };
}

async function getActiveAreas() {
  const [rows] = await safeCleanoxQuery(
    `SELECT id, code, name, sort_order
     FROM mst_kebersihan_areas
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`,
  );
  return rows || [];
}

export const listKebersihanEmployees = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const roleMap = await getCleanoxRoleMap();
    const assignedIds = Object.keys(roleMap).map(Number);
    const areas = await getActiveAreas();
    const requiredCount = areas.length || 4;

    if (assignedIds.length === 0) {
      return res.json({ success: true, total: 0, data: [], required_area_count: requiredCount });
    }

    const conditions = ["e.is_deleted = 0", "e.company_id = 3"];
    const params = [];
    const ph = assignedIds.map(() => "?").join(", ");
    conditions.push(`e.employee_id IN (${ph})`);
    params.push(...assignedIds);

    if (search) {
      conditions.push(
        "(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR u.username LIKE ?)",
      );
      const kw = `%${search}%`;
      params.push(kw, kw, kw, kw);
    }

    const whereSql = `WHERE ${conditions.join(" AND ")}`;
    const [rows] = await safeQuery(
      `
        SELECT
          e.employee_id,
          e.employee_code,
          e.full_name,
          e.email,
          e.phone_number,
          e.company_id,
          u.username
        FROM mst_employee e
        LEFT JOIN users u ON u.email = e.email
        ${whereSql}
        ORDER BY e.full_name ASC, e.employee_id DESC
      `,
      params,
    );

    const employeeIds = rows.map((r) => Number(r.employee_id));
    const reportAgg = {};
    const pendingAgg = {};

    if (employeeIds.length > 0) {
      const idPh = employeeIds.map(() => "?").join(", ");
      const [repRows] = await safeCleanoxQuery(
        `
          SELECT
            worker_id,
            COUNT(*) AS report_count,
            MAX(report_date) AS last_report_date
          FROM tr_worker_kebersihan_reports
          WHERE worker_id IN (${idPh})
          GROUP BY worker_id
        `,
        employeeIds,
      );

      for (const a of repRows || []) {
        reportAgg[Number(a.worker_id)] = {
          report_count: Number(a.report_count) || 0,
          last_report_date: toDateOnly(a.last_report_date),
        };
      }

      const [pendingRows] = await safeCleanoxQuery(
        `
          SELECT r.worker_id
          FROM tr_worker_kebersihan_reports r
          LEFT JOIN tr_worker_kebersihan_area_reviews v
            ON v.report_id = r.id
          WHERE r.worker_id IN (${idPh})
          GROUP BY r.id, r.worker_id
          HAVING COUNT(v.id) < ?
        `,
        [...employeeIds, requiredCount],
      );

      for (const p of pendingRows || []) {
        const wid = Number(p.worker_id);
        pendingAgg[wid] = (pendingAgg[wid] || 0) + 1;
      }
    }

    const data = rows.map((r) => {
      const id = Number(r.employee_id);
      const agg = reportAgg[id] || { report_count: 0, last_report_date: null };
      const pending = pendingAgg[id] || 0;
      let review_summary = "belum";
      if (agg.report_count > 0 && pending === 0) review_summary = "selesai";
      else if (agg.report_count > 0 && pending < agg.report_count) review_summary = "sebagian";
      else if (agg.report_count > 0) review_summary = "belum";

      return {
        ...r,
        cleanox_role: roleMap[id] ?? null,
        report_count: agg.report_count,
        last_report_date: agg.last_report_date,
        pending_review_count: pending,
        review_summary,
      };
    });

    return res.json({ success: true, total: data.length, data, required_area_count: requiredCount });
  } catch (error) {
    console.error("[listKebersihanEmployees]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil daftar karyawan kebersihan",
    });
  }
};

export const getKebersihanEmployee = async (req, res) => {
  try {
    const employee = await assertCleanoxCompany3Employee(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Karyawan Cleanox tidak ditemukan" });
    }
    return res.json({ success: true, data: employee });
  } catch (error) {
    console.error("[getKebersihanEmployee]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data karyawan",
    });
  }
};

export const listEmployeeKebersihanRecords = async (req, res) => {
  try {
    const employee = await assertCleanoxCompany3Employee(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Karyawan Cleanox tidak ditemukan" });
    }

    const areas = await getActiveAreas();
    const requiredCount = areas.length || 4;

    let startDate = String(req.query.startDate || "");
    let endDate = String(req.query.endDate || "");
    if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
      return res.status(400).json({ success: false, message: "Format tanggal harus YYYY-MM-DD" });
    }
    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate tidak boleh lebih besar dari endDate",
      });
    }

    const [rows] = await safeCleanoxQuery(
      `
        SELECT id, worker_id, report_date, session, status, completed_at
        FROM tr_worker_kebersihan_reports
        WHERE worker_id = ?
          AND report_date >= ?
          AND report_date <= ?
        ORDER BY report_date DESC, session ASC, id DESC
      `,
      [employee.employee_id, startDate, endDate],
    );

    const reportIds = (rows || []).map((r) => Number(r.id));
    const photosByReport = {};
    const reviewsByReport = {};

    if (reportIds.length > 0) {
      const ph = reportIds.map(() => "?").join(", ");
      const [photoRows] = await safeCleanoxQuery(
        `
          SELECT report_id, area_id, photo_file, photo_path, uploaded_at
          FROM tr_worker_kebersihan_photos
          WHERE report_id IN (${ph})
        `,
        reportIds,
      );
      for (const p of photoRows || []) {
        const rid = Number(p.report_id);
        if (!photosByReport[rid]) photosByReport[rid] = {};
        photosByReport[rid][Number(p.area_id)] = p;
      }

      const [reviewRows] = await safeCleanoxQuery(
        `
          SELECT report_id, area_id, score, reason, reviewed_by, reviewed_at
          FROM tr_worker_kebersihan_area_reviews
          WHERE report_id IN (${ph})
        `,
        reportIds,
      );

      const reviewerIds = [
        ...new Set((reviewRows || []).map((r) => Number(r.reviewed_by)).filter((n) => n > 0)),
      ];
      const nameMap = {};
      if (reviewerIds.length > 0) {
        const rph = reviewerIds.map(() => "?").join(", ");
        const [users] = await pool.query(
          `SELECT id, name FROM users WHERE id IN (${rph})`,
          reviewerIds,
        );
        for (const u of users || []) nameMap[Number(u.id)] = u.name;
      }

      for (const rev of reviewRows || []) {
        const rid = Number(rev.report_id);
        if (!reviewsByReport[rid]) reviewsByReport[rid] = {};
        reviewsByReport[rid][Number(rev.area_id)] = {
          ...rev,
          score: Number(rev.score),
          reviewed_by_name: nameMap[Number(rev.reviewed_by)] || null,
        };
      }
    }

    const data = (rows || []).map((row) => {
      const rid = Number(row.id);
      const photoMap = photosByReport[rid] || {};
      const reviewMap = reviewsByReport[rid] || {};
      const areasPayload = areas.map((area) => {
        const areaId = Number(area.id);
        const photo = photoMap[areaId] || null;
        const review = reviewMap[areaId] || null;
        return {
          area_id: areaId,
          code: area.code,
          name: area.name,
          sort_order: area.sort_order,
          has_photo: Boolean(photo),
          file: photo?.photo_file || null,
          url: photo?.photo_file
            ? `/cleanox/kebersihan/photos/${encodeURIComponent(photo.photo_file)}`
            : null,
          uploaded_at: photo?.uploaded_at || null,
          review: review
            ? {
                score: Number(review.score),
                reason: review.reason,
                reviewed_by: review.reviewed_by,
                reviewed_by_name: review.reviewed_by_name || null,
                reviewed_at: review.reviewed_at,
              }
            : null,
        };
      });
      const reviewedCount = areasPayload.filter((a) => a.review).length;
      return {
        id: rid,
        report_date: toDateOnly(row.report_date),
        session: row.session || "pagi",
        status: row.status,
        completed_at: row.completed_at,
        areas: areasPayload,
        reviewed_count: reviewedCount,
        review_status: reviewStatusFromCount(reviewedCount, requiredCount),
      };
    });

    return res.json({
      success: true,
      employee,
      startDate,
      endDate,
      required_area_count: requiredCount,
      data,
    });
  } catch (error) {
    console.error("[listEmployeeKebersihanRecords]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil riwayat kebersihan",
    });
  }
};

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return {
    startDate: toDateOnly(start),
    endDate: toDateOnly(end),
  };
}

function getReportStatusLabel(row, uploadedCount, requiredCount) {
  if (String(row.status) === "Completed" || uploadedCount >= requiredCount) return "Lengkap";
  if (uploadedCount > 0) return "Belum lengkap";
  return "Belum mulai";
}

export const listKebersihanRecords = async (req, res) => {
  try {
    const defaults = defaultDateRange();
    let startDate = String(req.query.startDate || defaults.startDate);
    let endDate = String(req.query.endDate || defaults.endDate);

    if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
      return res.status(400).json({ success: false, message: "Format tanggal harus YYYY-MM-DD" });
    }
    if (startDate > endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate tidak boleh lebih besar dari endDate",
      });
    }

    const areas = await getActiveAreas();
    const requiredCount = areas.length || 4;
    const roleMap = await getCleanoxRoleMap();
    const assignedIds = Object.keys(roleMap).map(Number);
    if (assignedIds.length === 0) {
      return res.json({
        success: true,
        startDate,
        endDate,
        required_area_count: requiredCount,
        total: 0,
        data: [],
      });
    }

    const idPh = assignedIds.map(() => "?").join(", ");
    const [rows] = await safeCleanoxQuery(
      `
        SELECT id, worker_id, report_date, session, status, completed_at
        FROM tr_worker_kebersihan_reports
        WHERE worker_id IN (${idPh})
          AND report_date >= ?
          AND report_date <= ?
        ORDER BY report_date DESC, session ASC, id DESC
      `,
      [...assignedIds, startDate, endDate],
    );

    const workerIds = [...new Set((rows || []).map((r) => Number(r.worker_id)))];
    const employeeMap = {};
    if (workerIds.length > 0) {
      const wPh = workerIds.map(() => "?").join(", ");
      const [emps] = await safeQuery(
        `
          SELECT e.employee_id, e.employee_code, e.full_name, u.username
          FROM mst_employee e
          LEFT JOIN users u ON u.email = e.email
          WHERE e.employee_id IN (${wPh})
            AND e.company_id = 3
            AND e.is_deleted = 0
        `,
        workerIds,
      );
      for (const e of emps || []) {
        employeeMap[Number(e.employee_id)] = e;
      }
    }

    const reportIds = (rows || []).map((r) => Number(r.id));
    const photosByReport = {};
    if (reportIds.length > 0) {
      const ph = reportIds.map(() => "?").join(", ");
      const [photoRows] = await safeCleanoxQuery(
        `
          SELECT report_id, area_id, photo_file, photo_path, uploaded_at
          FROM tr_worker_kebersihan_photos
          WHERE report_id IN (${ph})
        `,
        reportIds,
      );
      for (const p of photoRows || []) {
        const rid = Number(p.report_id);
        if (!photosByReport[rid]) photosByReport[rid] = {};
        photosByReport[rid][Number(p.area_id)] = p;
      }
    }

    const data = (rows || []).map((row) => {
      const rid = Number(row.id);
      const workerId = Number(row.worker_id);
      const emp = employeeMap[workerId] || {};
      const photoMap = photosByReport[rid] || {};
      const photos = areas.map((area) => {
        const areaId = Number(area.id);
        const photo = photoMap[areaId] || null;
        return {
          area_id: areaId,
          code: area.code,
          name: area.name,
          sort_order: area.sort_order,
          file: photo?.photo_file || null,
          url: photo?.photo_file
            ? `/cleanox/kebersihan/photos/${encodeURIComponent(photo.photo_file)}`
            : null,
          uploaded_at: photo?.uploaded_at || null,
        };
      });
      const uploadedCount = photos.filter((p) => p.file).length;
      return {
        id: rid,
        report_date: toDateOnly(row.report_date),
        session: row.session || "pagi",
        status: row.status,
        completed_at: row.completed_at,
        employee_id: workerId,
        employee_code: emp.employee_code || null,
        full_name: emp.full_name || null,
        username: emp.username || null,
        cleanox_role: roleMap[workerId] ?? null,
        photos,
        uploaded_count: uploadedCount,
        required_count: requiredCount,
        status_label: getReportStatusLabel(row, uploadedCount, requiredCount),
      };
    });

    return res.json({
      success: true,
      startDate,
      endDate,
      required_area_count: requiredCount,
      total: data.length,
      data,
    });
  } catch (error) {
    console.error("[listKebersihanRecords]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil riwayat kebersihan",
    });
  }
};

export const serveKebersihanPhoto = async (req, res) => {
  try {
    const dir = CLEANOX_KEBERSIHAN_DIR;
    if (!dir) {
      return res.status(500).json({
        success: false,
        message: "CLEANOX_BASE_DIR belum dikonfigurasi",
      });
    }

    const safeFileName = path.basename(String(req.params.filename || ""));
    if (!safeFileName) {
      return res.status(400).json({ success: false, message: "Nama file tidak valid" });
    }

    const fullPath = path.join(dir, safeFileName);
    const resolvedDir = path.resolve(dir);
    const resolvedFile = path.resolve(fullPath);
    if (!resolvedFile.startsWith(resolvedDir + path.sep) || !fs.existsSync(resolvedFile)) {
      return res.status(404).json({ success: false, message: "File kebersihan tidak ditemukan" });
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    return res.sendFile(resolvedFile);
  } catch (error) {
    console.error("[serveKebersihanPhoto]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menyajikan foto kebersihan",
    });
  }
};

export const upsertKebersihanAreaReviews = async (req, res) => {
  const connection = await cleanoxPool.getConnection();
  try {
    const reportId = Number(req.params.reportId);
    if (!Number.isInteger(reportId) || reportId <= 0) {
      return res.status(400).json({ success: false, message: "reportId tidak valid" });
    }

    const reviews = Array.isArray(req.body?.reviews) ? req.body.reviews : null;
    if (!reviews || reviews.length === 0) {
      return res.status(400).json({ success: false, message: "reviews wajib diisi" });
    }

    const [[report]] = await connection.query(
      `SELECT id, worker_id FROM tr_worker_kebersihan_reports WHERE id = ? LIMIT 1`,
      [reportId],
    );
    if (!report) {
      return res.status(404).json({ success: false, message: "Laporan kebersihan tidak ditemukan" });
    }

    const employee = await assertCleanoxCompany3Employee(report.worker_id);
    if (!employee) {
      return res.status(403).json({
        success: false,
        message: "Laporan ini bukan milik karyawan Cleanox (company_id 3)",
      });
    }

    const [activeAreas] = await connection.query(
      `SELECT id, name FROM mst_kebersihan_areas WHERE is_active = 1`,
    );
    const areaNameMap = {};
    const activeIds = new Set();
    for (const a of activeAreas || []) {
      activeIds.add(Number(a.id));
      areaNameMap[Number(a.id)] = a.name;
    }

    const [photoRows] = await connection.query(
      `SELECT area_id FROM tr_worker_kebersihan_photos WHERE report_id = ?`,
      [reportId],
    );
    const photoAreaIds = new Set((photoRows || []).map((p) => Number(p.area_id)));

    const reviewedBy = Number(req.session.userId);
    const normalized = [];
    const seen = new Set();

    for (const item of reviews) {
      const areaId = Number(item?.area_id);
      const score = normalizeScore(item?.score);
      const reason = String(item?.reason || "").trim();

      if (!Number.isInteger(areaId) || !activeIds.has(areaId)) {
        return res.status(400).json({
          success: false,
          message: `area_id tidak valid: ${item?.area_id}`,
        });
      }
      if (!photoAreaIds.has(areaId)) {
        return res.status(400).json({
          success: false,
          message: `Area ${areaNameMap[areaId] || areaId} belum punya foto`,
        });
      }
      if (score === null) {
        return res.status(400).json({
          success: false,
          message: `score untuk ${areaNameMap[areaId] || areaId} harus 0, 0.5, atau 1`,
        });
      }
      if (score === 0 && !reason) {
        return res.status(400).json({
          success: false,
          message: `Alasan wajib diisi untuk ${areaNameMap[areaId] || areaId}`,
        });
      }
      if (seen.has(areaId)) {
        return res.status(400).json({
          success: false,
          message: `area_id duplikat: ${areaId}`,
        });
      }
      seen.add(areaId);
      normalized.push({
        area_id: areaId,
        score,
        reason: score === 0 ? reason : "",
      });
    }

    await connection.beginTransaction();

    for (const item of normalized) {
      await connection.query(
        `
          INSERT INTO tr_worker_kebersihan_area_reviews
            (report_id, area_id, score, reason, reviewed_by, reviewed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            score = VALUES(score),
            reason = VALUES(reason),
            reviewed_by = VALUES(reviewed_by),
            reviewed_at = NOW(),
            updated_at = NOW()
        `,
        [reportId, item.area_id, item.score, item.reason, reviewedBy],
      );
    }

    await connection.commit();

    const [saved] = await connection.query(
      `
        SELECT report_id, area_id, score, reason, reviewed_by, reviewed_at
        FROM tr_worker_kebersihan_area_reviews
        WHERE report_id = ?
      `,
      [reportId],
    );

    const reviewedCount = (saved || []).length;
    return res.json({
      success: true,
      message: "Penilaian area kebersihan berhasil disimpan",
      reviewed_count: reviewedCount,
      review_status: reviewStatusFromCount(reviewedCount, activeIds.size || 4),
      data: saved,
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[upsertKebersihanAreaReviews]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menyimpan penilaian area kebersihan",
    });
  } finally {
    connection.release();
  }
};
