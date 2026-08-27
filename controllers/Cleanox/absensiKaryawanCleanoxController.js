import fs from "fs";
import path from "path";
import { pool, cleanoxPool, safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_ATTENDANCE_DIR } from "../../middleware/upload.js";
import { getCleanoxProduksiRoleMapObject } from "../../utils/cleanoxProduksiEmployees.js";

const PHOTO_TYPES = ["full_body", "side", "back", "hand"];

const PHOTO_LABELS = {
  full_body: "Foto Satu Badan",
  side: "Foto Samping",
  back: "Foto Belakang",
  hand: "Foto Tangan",
};

const PHOTO_FILE_FIELDS = {
  full_body: "full_body_photo_file",
  side: "side_photo_file",
  back: "back_photo_file",
  hand: "hand_photo_file",
};

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const s = String(value);
  return s.slice(0, 10);
}

/** Active cutoff 26→25 (same rule as cleanox-app Kasbon / Leave). */
function defaultDateRange(now = new Date()) {
  const day = now.getDate();
  let start;
  let end;
  if (day <= 25) {
    start = new Date(now.getFullYear(), now.getMonth() - 1, 26);
    end = new Date(now.getFullYear(), now.getMonth(), 25);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 26);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 25);
  }
  return {
    startDate: toDateOnly(start),
    endDate: toDateOnly(end),
  };
}

function isValidDateInput(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function reviewStatusFromCount(count) {
  const n = Number(count) || 0;
  if (n <= 0) return "belum";
  if (n >= 4) return "selesai";
  return "sebagian";
}

function getRecordStatus(row) {
  const hasCheckIn = Boolean(row.check_in_at);
  const hasCheckInPhoto = Boolean(row.check_in_photo_file);
  const hasCheckOut = Boolean(row.check_out_at);
  const hasAllQcPhotos = PHOTO_TYPES.every((type) => Boolean(row[PHOTO_FILE_FIELDS[type]]));
  const hasCheckOutPhoto = Boolean(row.check_out_photo_file);

  if (!hasCheckIn || !hasCheckInPhoto) return "Belum check-in";
  if (!hasAllQcPhotos) return "Belum foto grooming";
  if (!hasCheckOut) return "Belum check-out";
  if (!hasCheckOutPhoto) return "Foto belum lengkap";
  return "Lengkap";
}

function isAttendanceComplete(row) {
  return getRecordStatus(row) === "Lengkap";
}

function diffDays(startDate, endDate) {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.floor(ms / 86400000);
}

function emptyAttendanceSummary() {
  return {
    totalRecords: 0,
    totalEmployees: 0,
    checkedInCount: 0,
    checkedOutCount: 0,
    completeCount: 0,
    incompleteCount: 0,
  };
}

function buildAttendanceAggregates(rows, employeeMap, roleMap) {
  const list = rows || [];
  let checkedInCount = 0;
  let checkedOutCount = 0;
  let completeCount = 0;
  const byWorker = new Map();

  for (const row of list) {
    const workerId = Number(row.worker_id);
    const complete = isAttendanceComplete(row);
    if (row.check_in_at) checkedInCount += 1;
    if (row.check_out_at) checkedOutCount += 1;
    if (complete) completeCount += 1;

    if (!Number.isInteger(workerId) || workerId <= 0) continue;
    const prev = byWorker.get(workerId) || { record_count: 0, complete_count: 0 };
    prev.record_count += 1;
    if (complete) prev.complete_count += 1;
    byWorker.set(workerId, prev);
  }

  const totalRecords = list.length;
  const summary = {
    totalRecords,
    totalEmployees: byWorker.size,
    checkedInCount,
    checkedOutCount,
    completeCount,
    incompleteCount: totalRecords - completeCount,
  };

  const employeeSummary = [...byWorker.entries()]
    .map(([employeeId, agg]) => {
      const emp = employeeMap[employeeId] || {};
      return {
        employee_id: employeeId,
        employee_name: emp.full_name || `ID ${employeeId}`,
        employee_code: emp.employee_code || null,
        jabatan: roleMap[employeeId] || "-",
        record_count: agg.record_count,
        complete_count: agg.complete_count,
        incomplete_count: agg.record_count - agg.complete_count,
      };
    })
    .sort((a, b) => b.record_count - a.record_count)
    .slice(0, 500);

  return { summary, employeeSummary };
}

function buildCheckInPhoto(row) {
  const file = row.check_in_photo_file || null;
  if (!file) return null;
  return {
    file,
    url: `/cleanox/attendance/photos/${encodeURIComponent(file)}`,
  };
}

function buildCheckOutPhoto(row) {
  const file = row.check_out_photo_file || null;
  if (!file) return null;
  return {
    file,
    url: `/cleanox/attendance/photos/${encodeURIComponent(file)}`,
  };
}

/** Parse datetime-local (YYYY-MM-DDTHH:MM) → MySQL DATETIME string, or null if empty. */
function parseDateTimeLocal(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return undefined;
  const withSeconds = s.length === 16 ? `${s}:00` : s;
  const d = new Date(withSeconds);
  if (Number.isNaN(d.getTime())) return undefined;
  return withSeconds.replace("T", " ");
}

async function getCleanoxRoleMap() {
  return getCleanoxProduksiRoleMapObject();
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
       AND e.exit_date IS NULL
     LIMIT 1`,
    [id],
  );

  if (!rows.length) return null;
  return {
    ...rows[0],
    cleanox_role: roleMap[id] ?? null,
  };
}

function buildPhotosFromRow(row, reviewByType = {}) {
  return PHOTO_TYPES.map((photoType) => {
    const file = row[PHOTO_FILE_FIELDS[photoType]] || null;
    const review = reviewByType[photoType] || null;
    return {
      photo_type: photoType,
      label: PHOTO_LABELS[photoType],
      file,
      url: file ? `/cleanox/attendance/photos/${encodeURIComponent(file)}` : null,
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
}

export const listAttendanceEmployees = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const roleMap = await getCleanoxRoleMap();
    const assignedIds = Object.keys(roleMap).map(Number);

    if (assignedIds.length === 0) {
      return res.json({ success: true, total: 0, data: [] });
    }

    const conditions = ["e.is_deleted = 0", "e.company_id = 3", "e.exit_date IS NULL"];
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
    const attendanceAgg = {};
    const pendingAgg = {};

    if (employeeIds.length > 0) {
      const idPh = employeeIds.map(() => "?").join(", ");
      const [attRows] = await safeCleanoxQuery(
        `
          SELECT
            worker_id,
            COUNT(*) AS attendance_count,
            MAX(attendance_date) AS last_attendance_date
          FROM tr_worker_attendance
          WHERE worker_id IN (${idPh})
          GROUP BY worker_id
        `,
        employeeIds,
      );

      for (const a of attRows || []) {
        attendanceAgg[Number(a.worker_id)] = {
          attendance_count: Number(a.attendance_count) || 0,
          last_attendance_date: toDateOnly(a.last_attendance_date),
        };
      }

      const [pendingRows] = await safeCleanoxQuery(
        `
          SELECT a.worker_id, COUNT(*) AS pending_review_count
          FROM tr_worker_attendance a
          LEFT JOIN tr_worker_attendance_photo_reviews r
            ON r.attendance_id = a.id
          WHERE a.worker_id IN (${idPh})
          GROUP BY a.id, a.worker_id
          HAVING COUNT(r.id) < 4
        `,
        employeeIds,
      );

      for (const p of pendingRows || []) {
        const wid = Number(p.worker_id);
        pendingAgg[wid] = (pendingAgg[wid] || 0) + 1;
      }
    }

    const data = rows.map((r) => {
      const id = Number(r.employee_id);
      const agg = attendanceAgg[id] || { attendance_count: 0, last_attendance_date: null };
      const pending = pendingAgg[id] || 0;
      let review_summary = "belum";
      if (agg.attendance_count > 0 && pending === 0) review_summary = "selesai";
      else if (agg.attendance_count > 0 && pending < agg.attendance_count) review_summary = "sebagian";
      else if (agg.attendance_count > 0) review_summary = "belum";

      return {
        ...r,
        cleanox_role: roleMap[id] ?? null,
        attendance_count: agg.attendance_count,
        last_attendance_date: agg.last_attendance_date,
        pending_review_count: pending,
        review_summary,
      };
    });

    return res.json({ success: true, total: data.length, data });
  } catch (error) {
    console.error("[listAttendanceEmployees]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil daftar absensi karyawan",
    });
  }
};

export const getAttendanceEmployee = async (req, res) => {
  try {
    const employee = await assertCleanoxCompany3Employee(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Karyawan Cleanox tidak ditemukan" });
    }
    return res.json({ success: true, data: employee });
  } catch (error) {
    console.error("[getAttendanceEmployee]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data karyawan",
    });
  }
};

export const listAttendanceRecords = async (req, res) => {
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
    if (diffDays(startDate, endDate) > 62) {
      return res.status(400).json({
        success: false,
        message: "Range tanggal maksimal 63 hari",
      });
    }

    const emptyPayload = {
      success: true,
      startDate,
      endDate,
      total: 0,
      summary: emptyAttendanceSummary(),
      employeeSummary: [],
      data: [],
    };

    const roleMap = await getCleanoxRoleMap();
    const assignedIds = Object.keys(roleMap).map(Number);
    if (assignedIds.length === 0) {
      return res.json(emptyPayload);
    }

    const idPh = assignedIds.map(() => "?").join(", ");
    const [empRows] = await safeQuery(
      `
        SELECT
          e.employee_id,
          e.employee_code,
          e.full_name,
          e.email,
          u.username
        FROM mst_employee e
        LEFT JOIN users u ON u.email = e.email
        WHERE e.is_deleted = 0
          AND e.company_id = 3
          AND e.exit_date IS NULL
          AND e.employee_id IN (${idPh})
      `,
      assignedIds,
    );

    const employeeMap = {};
    for (const e of empRows || []) {
      employeeMap[Number(e.employee_id)] = e;
    }
    const workerIds = Object.keys(employeeMap).map(Number);
    if (workerIds.length === 0) {
      return res.json(emptyPayload);
    }

    const workerPh = workerIds.map(() => "?").join(", ");
    const [rows] = await safeCleanoxQuery(
      `
        SELECT *
        FROM tr_worker_attendance
        WHERE worker_id IN (${workerPh})
          AND attendance_date >= ?
          AND attendance_date <= ?
        ORDER BY attendance_date DESC, id DESC
      `,
      [...workerIds, startDate, endDate],
    );

    const attendanceIds = (rows || []).map((r) => Number(r.id));
    const reviewsByAttendance = {};

    if (attendanceIds.length > 0) {
      const ph = attendanceIds.map(() => "?").join(", ");
      const [reviewRows] = await safeCleanoxQuery(
        `
          SELECT attendance_id, photo_type, score, reason, reviewed_by, reviewed_at
          FROM tr_worker_attendance_photo_reviews
          WHERE attendance_id IN (${ph})
        `,
        attendanceIds,
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
        const aid = Number(rev.attendance_id);
        if (!reviewsByAttendance[aid]) reviewsByAttendance[aid] = {};
        reviewsByAttendance[aid][rev.photo_type] = {
          ...rev,
          reviewed_by_name: nameMap[Number(rev.reviewed_by)] || null,
        };
      }
    }

    const data = (rows || []).map((row) => {
      const aid = Number(row.id);
      const workerId = Number(row.worker_id);
      const emp = employeeMap[workerId] || {};
      const reviewMap = reviewsByAttendance[aid] || {};
      const photos = buildPhotosFromRow(row, reviewMap);
      const reviewedCount = photos.filter((p) => p.review).length;

      return {
        id: aid,
        attendance_date: toDateOnly(row.attendance_date),
        employee_id: workerId,
        employee_code: emp.employee_code || null,
        full_name: emp.full_name || null,
        username: emp.username || null,
        cleanox_role: roleMap[workerId] ?? null,
        check_in_at: row.check_in_at,
        check_out_at: row.check_out_at,
        check_in_photo: buildCheckInPhoto(row),
        photos,
        check_out_photo: buildCheckOutPhoto(row),
        reviewed_count: reviewedCount,
        review_status: reviewStatusFromCount(reviewedCount),
        status_label: getRecordStatus(row),
      };
    });

    const { summary, employeeSummary } = buildAttendanceAggregates(rows || [], employeeMap, roleMap);

    return res.json({
      success: true,
      startDate,
      endDate,
      total: data.length,
      summary,
      employeeSummary,
      data,
    });
  } catch (error) {
    console.error("[listAttendanceRecords]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil riwayat absensi",
    });
  }
};

export const listEmployeeAttendanceRecords = async (req, res) => {
  try {
    const employee = await assertCleanoxCompany3Employee(req.params.employeeId);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Karyawan Cleanox tidak ditemukan" });
    }

    const defaults = defaultDateRange();
    let startDate = String(req.query.startDate || defaults.startDate);
    let endDate = String(req.query.endDate || defaults.endDate);

    if (!isValidDateInput(startDate) || !isValidDateInput(endDate)) {
      return res.status(400).json({ success: false, message: "Format tanggal harus YYYY-MM-DD" });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, message: "startDate tidak boleh lebih besar dari endDate" });
    }

    const [rows] = await safeCleanoxQuery(
      `
        SELECT *
        FROM tr_worker_attendance
        WHERE worker_id = ?
          AND attendance_date >= ?
          AND attendance_date <= ?
        ORDER BY attendance_date DESC, id DESC
      `,
      [employee.employee_id, startDate, endDate],
    );

    const attendanceIds = (rows || []).map((r) => Number(r.id));
    const reviewsByAttendance = {};

    if (attendanceIds.length > 0) {
      const ph = attendanceIds.map(() => "?").join(", ");
      const [reviewRows] = await safeCleanoxQuery(
        `
          SELECT attendance_id, photo_type, score, reason, reviewed_by, reviewed_at
          FROM tr_worker_attendance_photo_reviews
          WHERE attendance_id IN (${ph})
        `,
        attendanceIds,
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
        const aid = Number(rev.attendance_id);
        if (!reviewsByAttendance[aid]) reviewsByAttendance[aid] = {};
        reviewsByAttendance[aid][rev.photo_type] = {
          ...rev,
          reviewed_by_name: nameMap[Number(rev.reviewed_by)] || null,
        };
      }
    }

    const data = (rows || []).map((row) => {
      const aid = Number(row.id);
      const reviewMap = reviewsByAttendance[aid] || {};
      const photos = buildPhotosFromRow(row, reviewMap);
      const reviewedCount = photos.filter((p) => p.review).length;
      return {
        id: aid,
        attendance_date: toDateOnly(row.attendance_date),
        check_in_at: row.check_in_at,
        check_out_at: row.check_out_at,
        photos,
        reviewed_count: reviewedCount,
        review_status: reviewStatusFromCount(reviewedCount),
      };
    });

    return res.json({
      success: true,
      employee,
      startDate,
      endDate,
      data,
    });
  } catch (error) {
    console.error("[listEmployeeAttendanceRecords]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil riwayat absensi",
    });
  }
};

export const serveAttendancePhoto = async (req, res) => {
  try {
    const dir = CLEANOX_ATTENDANCE_DIR;
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
      return res.status(404).json({ success: false, message: "File attendance tidak ditemukan" });
    }

    res.setHeader("Cache-Control", "private, max-age=300");
    return res.sendFile(resolvedFile);
  } catch (error) {
    console.error("[serveAttendancePhoto]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menyajikan foto absensi",
    });
  }
};

export const createAttendanceRecord = async (req, res) => {
  try {
    const employeeId = Number(req.body.employee_id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ success: false, message: "employee_id tidak valid" });
    }

    const employee = await assertCleanoxCompany3Employee(employeeId);
    if (!employee) {
      return res.status(404).json({
        success: false,
        message: "Karyawan Cleanox tidak ditemukan",
      });
    }

    const attendanceDate = String(req.body.attendance_date || "");
    if (!isValidDateInput(attendanceDate)) {
      return res.status(400).json({
        success: false,
        message: "attendance_date tidak valid (format: YYYY-MM-DD)",
      });
    }

    const hasCheckIn = "check_in_at" in req.body;
    const hasCheckOut = "check_out_at" in req.body;
    const checkInRaw = hasCheckIn ? req.body.check_in_at : null;
    const checkOutRaw = hasCheckOut ? req.body.check_out_at : null;

    const checkInParsed = checkInRaw ? parseDateTimeLocal(checkInRaw) : null;
    const checkOutParsed = checkOutRaw ? parseDateTimeLocal(checkOutRaw) : null;

    if (checkInRaw && checkInParsed === undefined) {
      return res.status(400).json({
        success: false,
        message: "Format check_in_at tidak valid. Gunakan YYYY-MM-DDTHH:MM",
      });
    }
    if (checkOutRaw && checkOutParsed === undefined) {
      return res.status(400).json({
        success: false,
        message: "Format check_out_at tidak valid. Gunakan YYYY-MM-DDTHH:MM",
      });
    }
    if (checkInParsed && checkOutParsed) {
      const inTs = new Date(checkInParsed).getTime();
      const outTs = new Date(checkOutParsed).getTime();
      if (Number.isFinite(inTs) && Number.isFinite(outTs) && outTs <= inTs) {
        return res.status(400).json({
          success: false,
          message: "Jam keluar harus lebih besar dari jam masuk",
        });
      }
    }

    const [existing] = await safeCleanoxQuery(
      `SELECT id FROM tr_worker_attendance WHERE worker_id = ? AND attendance_date = ? LIMIT 1`,
      [employeeId, attendanceDate],
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Record absensi untuk karyawan dan tanggal ini sudah ada",
      });
    }

    const [result] = await safeCleanoxQuery(
      `
        INSERT INTO tr_worker_attendance (worker_id, attendance_date, check_in_at, check_out_at)
        VALUES (?, ?, ?, ?)
      `,
      [employeeId, attendanceDate, checkInParsed, checkOutParsed],
    );

    const insertId = Number(result?.insertId || 0);

    return res.status(201).json({
      success: true,
      message: "Data absensi berhasil ditambahkan",
      data: {
        id: insertId || null,
        employee_id: employeeId,
        attendance_date: attendanceDate,
        check_in_at: checkInParsed,
        check_out_at: checkOutParsed,
      },
    });
  } catch (error) {
    if (error?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Record absensi untuk karyawan dan tanggal ini sudah ada",
      });
    }
    console.error("[createAttendanceRecord]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menambahkan absensi",
    });
  }
};

export const updateAttendanceRecord = async (req, res) => {
  try {
    const attendanceId = Number(req.params.attendanceId);
    if (!Number.isInteger(attendanceId) || attendanceId <= 0) {
      return res.status(400).json({ success: false, message: "attendanceId tidak valid" });
    }

    const hasCheckIn = "check_in_at" in req.body;
    const hasCheckOut = "check_out_at" in req.body;
    if (!hasCheckIn && !hasCheckOut) {
      return res.status(400).json({
        success: false,
        message: "Tidak ada field yang diubah. Sediakan check_in_at dan/atau check_out_at.",
      });
    }

    const checkInParsed = hasCheckIn ? parseDateTimeLocal(req.body.check_in_at) : undefined;
    const checkOutParsed = hasCheckOut ? parseDateTimeLocal(req.body.check_out_at) : undefined;
    if (hasCheckIn && checkInParsed === undefined) {
      return res.status(400).json({
        success: false,
        message: "Format check_in_at tidak valid. Gunakan YYYY-MM-DDTHH:MM",
      });
    }
    if (hasCheckOut && checkOutParsed === undefined) {
      return res.status(400).json({
        success: false,
        message: "Format check_out_at tidak valid. Gunakan YYYY-MM-DDTHH:MM",
      });
    }

    const [rows] = await safeCleanoxQuery(
      `SELECT * FROM tr_worker_attendance WHERE id = ? LIMIT 1`,
      [attendanceId],
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Record absensi tidak ditemukan" });
    }

    const current = rows[0];
    const employee = await assertCleanoxCompany3Employee(current.worker_id);
    if (!employee) {
      return res.status(403).json({
        success: false,
        message: "Absensi ini bukan milik karyawan Cleanox (company_id 3)",
      });
    }

    const nextCheckIn = hasCheckIn ? checkInParsed : current.check_in_at;
    const nextCheckOut = hasCheckOut ? checkOutParsed : current.check_out_at;
    if (nextCheckIn && nextCheckOut) {
      const inTs = new Date(nextCheckIn).getTime();
      const outTs = new Date(nextCheckOut).getTime();
      if (Number.isFinite(inTs) && Number.isFinite(outTs) && outTs <= inTs) {
        return res.status(400).json({
          success: false,
          message: "Jam keluar harus lebih besar dari jam masuk",
        });
      }
    }

    const setClauses = ["updated_at = NOW()"];
    const params = [];
    if (hasCheckIn) {
      setClauses.push("check_in_at = ?");
      params.push(checkInParsed);
    }
    if (hasCheckOut) {
      setClauses.push("check_out_at = ?");
      params.push(checkOutParsed);
    }
    params.push(attendanceId);

    await safeCleanoxQuery(
      `UPDATE tr_worker_attendance SET ${setClauses.join(", ")} WHERE id = ?`,
      params,
    );

    const [updatedRows] = await safeCleanoxQuery(
      `SELECT * FROM tr_worker_attendance WHERE id = ? LIMIT 1`,
      [attendanceId],
    );
    const updated = updatedRows[0];

    return res.json({
      success: true,
      message: "Jam absensi berhasil diperbarui",
      data: {
        id: Number(updated.id),
        check_in_at: updated.check_in_at,
        check_out_at: updated.check_out_at,
        status_label: getRecordStatus(updated),
      },
    });
  } catch (error) {
    console.error("[updateAttendanceRecord]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal memperbarui absensi",
    });
  }
};

export const deleteAttendanceRecord = async (req, res) => {
  try {
    const attendanceId = Number(req.params.attendanceId);
    if (!Number.isInteger(attendanceId) || attendanceId <= 0) {
      return res.status(400).json({ success: false, message: "attendanceId tidak valid" });
    }

    const [rows] = await safeCleanoxQuery(
      `SELECT id, worker_id FROM tr_worker_attendance WHERE id = ? LIMIT 1`,
      [attendanceId],
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Record absensi tidak ditemukan" });
    }

    const employee = await assertCleanoxCompany3Employee(rows[0].worker_id);
    if (!employee) {
      return res.status(403).json({
        success: false,
        message: "Absensi ini bukan milik karyawan Cleanox (company_id 3)",
      });
    }

    await safeCleanoxQuery(`DELETE FROM tr_worker_attendance WHERE id = ?`, [attendanceId]);

    return res.json({ success: true, message: "Record absensi berhasil dihapus" });
  } catch (error) {
    console.error("[deleteAttendanceRecord]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menghapus absensi",
    });
  }
};

export const upsertAttendancePhotoReviews = async (req, res) => {
  const connection = await cleanoxPool.getConnection();
  try {
    const attendanceId = Number(req.params.attendanceId);
    if (!Number.isInteger(attendanceId) || attendanceId <= 0) {
      return res.status(400).json({ success: false, message: "attendanceId tidak valid" });
    }

    const reviews = Array.isArray(req.body?.reviews) ? req.body.reviews : null;
    if (!reviews || reviews.length === 0) {
      return res.status(400).json({ success: false, message: "reviews wajib diisi" });
    }

    const [[attendance]] = await connection.query(
      `SELECT id, worker_id FROM tr_worker_attendance WHERE id = ? LIMIT 1`,
      [attendanceId],
    );
    if (!attendance) {
      return res.status(404).json({ success: false, message: "Record absensi tidak ditemukan" });
    }

    const employee = await assertCleanoxCompany3Employee(attendance.worker_id);
    if (!employee) {
      return res.status(403).json({
        success: false,
        message: "Absensi ini bukan milik karyawan Cleanox (company_id 3)",
      });
    }

    const reviewedBy = Number(req.session.userId);
    const normalized = [];
    const seen = new Set();

    for (const item of reviews) {
      const photoType = String(item?.photo_type || "").trim();
      const score = Number(item?.score);
      const reason = String(item?.reason || "").trim();

      if (!PHOTO_TYPES.includes(photoType)) {
        return res.status(400).json({
          success: false,
          message: `photo_type tidak valid: ${photoType}`,
        });
      }
      if (score !== 0 && score !== 1) {
        return res.status(400).json({
          success: false,
          message: `score untuk ${photoType} harus 0 atau 1`,
        });
      }
      if (score === 0 && !reason) {
        return res.status(400).json({
          success: false,
          message: `Alasan wajib diisi untuk ${PHOTO_LABELS[photoType]}`,
        });
      }
      if (seen.has(photoType)) {
        return res.status(400).json({
          success: false,
          message: `photo_type duplikat: ${photoType}`,
        });
      }
      seen.add(photoType);
      normalized.push({
        photo_type: photoType,
        score,
        reason: score === 0 ? reason : "",
      });
    }

    await connection.beginTransaction();

    for (const item of normalized) {
      await connection.query(
        `
          INSERT INTO tr_worker_attendance_photo_reviews
            (attendance_id, photo_type, score, reason, reviewed_by, reviewed_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            score = VALUES(score),
            reason = VALUES(reason),
            reviewed_by = VALUES(reviewed_by),
            reviewed_at = NOW(),
            updated_at = NOW()
        `,
        [attendanceId, item.photo_type, item.score, item.reason, reviewedBy],
      );
    }

    await connection.commit();

    const [saved] = await connection.query(
      `
        SELECT attendance_id, photo_type, score, reason, reviewed_by, reviewed_at
        FROM tr_worker_attendance_photo_reviews
        WHERE attendance_id = ?
      `,
      [attendanceId],
    );

    const reviewedCount = (saved || []).length;
    return res.json({
      success: true,
      message: "Penilaian foto berhasil disimpan",
      reviewed_count: reviewedCount,
      review_status: reviewStatusFromCount(reviewedCount),
      data: saved,
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[upsertAttendancePhotoReviews]", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Gagal menyimpan penilaian foto",
    });
  } finally {
    connection.release();
  }
};
