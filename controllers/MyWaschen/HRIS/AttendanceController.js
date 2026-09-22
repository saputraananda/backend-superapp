import { safeMyWaschenQuery } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getEmployeeNameMap, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause, toMySQLDatetime, resolveEmployeeUserId, resolveEmployeeOutletId, validateOutletId } from "./hrisHelpers.js";

import { buildAttendancePhotoUrl, getWaschenMobileAttendanceDir } from "./hrisAssetHelpers.js";

import fs from "fs";
import path from "path";



const GROOMING_ROLES = new Set(["Frontliner", "Delivery Staff"]);

function requiresGrooming(role) {
  return GROOMING_ROLES.has(String(role || "").trim());
}

function deriveGroomingStatus(photoCount, role) {
  if (!requiresGrooming(role)) return "tidak_wajib";
  const n = Number(photoCount) || 0;
  if (n >= 6) return "lengkap";
  if (n === 0) return "kosong";
  return "kurang";
}

async function getEmployeeRoleMap(employeeIds = []) {
  const ids = [...new Set(employeeIds.map(Number).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => "?").join(",");
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT employee_id, role FROM mst_role WHERE employee_id IN (${ph})`,
      ids,
    );
    rows.forEach((r) => map.set(Number(r.employee_id), String(r.role || "").trim()));
  } catch (_) { /* optional */ }
  return map;
}

async function getGroomingPhotoCountMap(attendanceIds = []) {
  const ids = [...new Set(attendanceIds.map(Number).filter((id) => id > 0))];
  const map = new Map();
  if (!ids.length) return map;
  const ph = ids.map(() => "?").join(",");
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT attendance_id, COUNT(*) AS n
       FROM tr_attendance_grooming_photo
       WHERE attendance_id IN (${ph})
       GROUP BY attendance_id`,
      ids,
    );
    rows.forEach((r) => map.set(Number(r.attendance_id), Number(r.n) || 0));
  } catch (_) { /* optional */ }
  return map;
}

const formatTime = (dt) => {

  if (!dt) return null;

  const d = new Date(dt);

  if (Number.isNaN(d.getTime())) return null;

  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false });

};



function attendanceStatusLabel(row) {

  const hasIn = Boolean(row.check_in_time);

  const hasOut = Boolean(row.check_out_time);

  const hasInPhoto = Boolean(row.check_in_photo_name);

  const hasOutPhoto = Boolean(row.check_out_photo_name);

  if (!hasIn) return "Belum check-in";

  if (!hasOut) return "Belum check-out";

  if (!hasInPhoto || !hasOutPhoto) return "Foto belum lengkap";

  return "Lengkap";

}



/** Hapus foto absensi: lokal (dev path) ATAU remote ke Waschen Mobile (prod HTTP). */
async function tryDeleteAttendancePhoto(photoName) {
  if (!photoName) return;

  const dir = getWaschenMobileAttendanceDir();
  if (dir) {
    try {
      const fp = path.join(dir, photoName);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (_) {
      /* ignore */
    }
    return;
  }

  // Prod: file ada di server Waschen Mobile
  const base = (process.env.WASCHEN_MOBILE_API_URL || "").replace(/\/$/, "");
  if (!base) return;
  const secret =
    process.env.WASCHEN_MOBILE_REALTIME_SECRET ||
    process.env.REALTIME_SECRET ||
    process.env.SESSION_SECRET ||
    "waschensecret";

  try {
    await fetch(`${base}/api/realtime/delete-upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Realtime-Secret": secret,
      },
      body: JSON.stringify({ type: "attendance", fileName: photoName }),
    });
  } catch (err) {
    console.warn("[tryDeleteAttendancePhoto] remote skip:", err?.message || err);
  }
}



function mapAttendanceRow(req, r, empMap, roleMap = null, photoCountMap = null) {
  const statusLabel = attendanceStatusLabel(r);
  const role = roleMap?.get(Number(r.employee_id)) || r.role_code || r.role || null;
  const stored = r.grooming_status || null;
  const photoCount = photoCountMap?.has(Number(r.attendance_id))
    ? photoCountMap.get(Number(r.attendance_id))
    : null;

  let groomingStatus;
  if (requiresGrooming(role)) {
    // Frontliner / Delivery: jangan pernah tampil "tidak_wajib"
    if (photoCount != null) {
      groomingStatus = deriveGroomingStatus(photoCount, role);
    } else if (stored && stored !== "tidak_wajib") {
      groomingStatus = stored;
    } else {
      groomingStatus = "kosong";
    }
  } else {
    groomingStatus = "tidak_wajib";
  }

  return {
    attendance_id: r.attendance_id,
    employee_id: r.employee_id,
    employee_name: empMap.get(Number(r.employee_id))?.full_name || `#${r.employee_id}`,
    employee_code: empMap.get(Number(r.employee_id))?.employee_code || null,
    outlet_id: r.outlet_id,
    work_date: toISODate(r.work_date),
    check_in_time: r.check_in_time,
    check_out_time: r.check_out_time,
    check_in: formatTime(r.check_in_time),
    check_out: formatTime(r.check_out_time),
    check_in_lat: r.check_in_lat,
    check_in_lng: r.check_in_lng,
    check_out_lat: r.check_out_lat,
    check_out_lng: r.check_out_lng,
    check_in_photo_url: buildAttendancePhotoUrl(req, r.check_in_photo_path, r.check_in_photo_name),
    check_out_photo_url: buildAttendancePhotoUrl(req, r.check_out_photo_path, r.check_out_photo_name),
    has_check_in: Boolean(r.check_in_time),
    status_label: statusLabel,
    role_code: role,
    grooming_status: groomingStatus,
    grooming_incomplete_reason: r.grooming_incomplete_reason || null,
    grooming_locked_at: r.grooming_locked_at || null,
  };
}



export const getAttendanceList = async (req, res) => {

  try {

    const defaults = defaultCutoffDateRange();

    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;

    const endDate = toISODate(req.query.endDate) || defaults.dateTo;

    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    const outletId = req.query.outletId ? Number(req.query.outletId) : null;

    const role = req.query.role ? String(req.query.role).trim() : "";

    const onlyIncomplete = String(req.query.onlyIncomplete || "") === "1";

    const search = String(req.query.search || "").trim().toLowerCase();

    const roleEmployeeIds = await resolveMstRoleEmployeeIds(outletId, role);

    if (roleEmployeeIds && roleEmployeeIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        summary: {
          totalRecords: 0,
          completeCount: 0,
          incompleteCount: 0,
          totalCheckIn: 0,
          totalLeave: 0,
          leavePengajuan: 0,
        },
      });
    }

    const cond = [];

    const params = [];

    if (startDate) {

      cond.push("a.work_date >= ?");

      params.push(startDate);

    }

    if (endDate) {

      cond.push("a.work_date <= ?");

      params.push(endDate);

    }

    if (employeeId) {

      cond.push("a.employee_id = ?");

      params.push(employeeId);

    }

    appendEmployeeIdInClause(cond, params, roleEmployeeIds, "a.employee_id");

    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";



    let attRows;
    try {
      const [rows] = await safeMyWaschenQuery(
        `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
                a.check_in_time, a.check_in_lat, a.check_in_lng,
                a.check_in_photo_path, a.check_in_photo_name,
                a.check_out_time, a.check_out_lat, a.check_out_lng,
                a.check_out_photo_path, a.check_out_photo_name,
                a.grooming_status, a.grooming_incomplete_reason, a.grooming_locked_at
         FROM tr_attendance a
         ${where}
         ORDER BY a.work_date DESC, a.check_in_time DESC
         LIMIT 1000`,
        params,
      );
      attRows = rows;
    } catch (selErr) {
      if (selErr.code !== "ER_BAD_FIELD_ERROR") throw selErr;
      const [rows] = await safeMyWaschenQuery(
        `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
                a.check_in_time, a.check_in_lat, a.check_in_lng,
                a.check_in_photo_path, a.check_in_photo_name,
                a.check_out_time, a.check_out_lat, a.check_out_lng,
                a.check_out_photo_path, a.check_out_photo_name
         FROM tr_attendance a
         ${where}
         ORDER BY a.work_date DESC, a.check_in_time DESC
         LIMIT 1000`,
        params,
      );
      attRows = rows;
    }



    let leaveWhere = "WHERE l.status IN ('pengajuan','disetujui')";

    const leaveParams = [];

    if (startDate) {

      leaveWhere += " AND l.end_date >= ?";

      leaveParams.push(startDate);

    }

    if (endDate) {

      leaveWhere += " AND l.start_date <= ?";

      leaveParams.push(endDate);

    }

    if (employeeId) {

      leaveWhere += " AND l.employee_id = ?";

      leaveParams.push(employeeId);

    }

    if (roleEmployeeIds) {
      const ph = roleEmployeeIds.map(() => "?").join(",");
      leaveWhere += ` AND l.employee_id IN (${ph})`;
      leaveParams.push(...roleEmployeeIds);
    }



    const [leaveRows] = await safeMyWaschenQuery(

      `SELECT l.leave_id, l.employee_id, l.leave_type, l.status

       FROM tr_leave l

       ${leaveWhere}`,

      leaveParams,

    );



    const empIds = attRows.map((r) => r.employee_id);
    const empMap = await getEmployeeNameMap(empIds);
    const roleMap = await getEmployeeRoleMap(empIds);
    const photoCountMap = await getGroomingPhotoCountMap(attRows.map((r) => r.attendance_id));

    let attendance = attRows.map((r) => mapAttendanceRow(req, r, empMap, roleMap, photoCountMap));

    // Perbaiki data lama Frontliner/Delivery yang masih tersimpan sebagai tidak_wajib
    const fixIds = attendance
      .filter((a) => requiresGrooming(a.role_code) && a.grooming_status !== "tidak_wajib")
      .filter((a) => {
        const raw = attRows.find((x) => Number(x.attendance_id) === Number(a.attendance_id));
        return raw && raw.grooming_status === "tidak_wajib";
      })
      .map((a) => a.attendance_id);
    if (fixIds.length) {
      try {
        const ph = fixIds.map(() => "?").join(",");
        await safeMyWaschenQuery(
          `UPDATE tr_attendance SET grooming_status = 'kosong'
           WHERE attendance_id IN (${ph}) AND grooming_status = 'tidak_wajib'`,
          fixIds,
        );
      } catch (_) { /* non-blocking */ }
    }



    if (onlyIncomplete) {

      attendance = attendance.filter((a) => a.status_label !== "Lengkap");

    }

    if (search) {

      attendance = attendance.filter(

        (a) =>

          a.employee_name?.toLowerCase().includes(search) ||

          a.employee_code?.toLowerCase().includes(search) ||

          a.status_label?.toLowerCase().includes(search),

      );

    }



    const summary = {

      totalRecords: attendance.length,

      completeCount: attendance.filter((a) => a.status_label === "Lengkap").length,

      incompleteCount: attendance.filter((a) => a.status_label !== "Lengkap").length,

      totalCheckIn: attendance.filter((a) => a.has_check_in).length,

      totalLeave: leaveRows.length,

      leavePengajuan: leaveRows.filter((r) => r.status === "pengajuan").length,

    };



    return res.json({ success: true, data: attendance, summary });

  } catch (err) {

    console.error("getAttendanceList:", err);

    return res.status(500).json({ success: false, message: err.message || "Gagal memuat absensi" });

  }

};



export const createAttendance = async (req, res) => {
  try {
    const employeeId = Number(req.body.employee_id);
    const workDate = toISODate(req.body.work_date);
    if (!employeeId || !workDate) {
      return res.status(422).json({ success: false, message: "Karyawan dan tanggal kerja wajib diisi" });
    }

    const checkInRaw = req.body.check_in_time || null;
    const checkOutRaw = req.body.check_out_time || null;
    const checkInTime = checkInRaw ? toMySQLDatetime(checkInRaw) : null;
    const checkOutTime = checkOutRaw ? toMySQLDatetime(checkOutRaw) : null;

    if (checkInRaw && !checkInTime) {
      return res.status(422).json({ success: false, message: "Format jam masuk tidak valid" });
    }
    if (checkOutRaw && !checkOutTime) {
      return res.status(422).json({ success: false, message: "Format jam keluar tidak valid" });
    }
    if (!checkInTime && !checkOutTime) {
      return res.status(422).json({ success: false, message: "Minimal isi jam masuk atau jam keluar" });
    }
    if (checkInTime && checkOutTime && new Date(checkOutTime) <= new Date(checkInTime)) {
      return res.status(422).json({ success: false, message: "Jam keluar harus lebih besar dari jam masuk" });
    }

    const outletId = await resolveEmployeeOutletId(employeeId, req.body.outlet_id);
    if (!outletId || !(await validateOutletId(outletId))) {
      return res.status(422).json({ success: false, message: "Outlet wajib dipilih atau belum ditetapkan di mst_role karyawan" });
    }

    const [dup] = await safeMyWaschenQuery(
      `SELECT attendance_id FROM tr_attendance WHERE employee_id = ? AND work_date = ? LIMIT 1`,
      [employeeId, workDate],
    );
    if (dup.length) {
      return res.status(409).json({ success: false, message: "Absensi karyawan pada tanggal ini sudah ada" });
    }

    const userId = await resolveEmployeeUserId(employeeId);
    const roleMap = await getEmployeeRoleMap([employeeId]);
    const empRole = roleMap.get(Number(employeeId)) || null;
    const groomingStatus = requiresGrooming(empRole) ? "kosong" : "tidak_wajib";

    let result;
    try {
      [result] = await safeMyWaschenQuery(
        `INSERT INTO tr_attendance (user_id, employee_id, outlet_id, work_date, check_in_time, check_out_time, grooming_status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, employeeId, outletId, workDate, checkInTime, checkOutTime, groomingStatus],
      );
    } catch (insErr) {
      if (insErr.code !== "ER_BAD_FIELD_ERROR") throw insErr;
      [result] = await safeMyWaschenQuery(
        `INSERT INTO tr_attendance (user_id, employee_id, outlet_id, work_date, check_in_time, check_out_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, employeeId, outletId, workDate, checkInTime, checkOutTime],
      );
    }

    const [rows] = await safeMyWaschenQuery(
      `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
              a.check_in_time, a.check_in_lat, a.check_in_lng,
              a.check_in_photo_path, a.check_in_photo_name,
              a.check_out_time, a.check_out_lat, a.check_out_lng,
              a.check_out_photo_path, a.check_out_photo_name,
              a.grooming_status, a.grooming_incomplete_reason, a.grooming_locked_at
       FROM tr_attendance a WHERE a.attendance_id = ? LIMIT 1`,
      [result.insertId],
    );

    const empMap = await getEmployeeNameMap([employeeId]);
    return res.status(201).json({
      success: true,
      message: "Absensi berhasil ditambahkan",
      data: mapAttendanceRow(req, rows[0], empMap, roleMap),
    });
  } catch (err) {
    console.error("createAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal menambahkan absensi" });
  }
};



export const updateAttendance = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "ID absensi tidak valid" });

    const [existing] = await safeMyWaschenQuery(
      `SELECT * FROM tr_attendance WHERE attendance_id = ? LIMIT 1`,
      [id],
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: "Data absensi tidak ditemukan" });
    }

    const row = existing[0];
    const updates = [];
    const params = [];

    if ("work_date" in req.body) {
      const workDate = toISODate(req.body.work_date);
      if (!workDate) return res.status(422).json({ success: false, message: "Tanggal kerja tidak valid" });
      if (workDate !== toISODate(row.work_date)) {
        const [dup] = await safeMyWaschenQuery(
          `SELECT attendance_id FROM tr_attendance WHERE employee_id = ? AND work_date = ? AND attendance_id != ? LIMIT 1`,
          [row.employee_id, workDate, id],
        );
        if (dup.length) {
          return res.status(409).json({ success: false, message: "Absensi karyawan pada tanggal tersebut sudah ada" });
        }
      }
      updates.push("work_date = ?");
      params.push(workDate);
    }

    if ("outlet_id" in req.body) {
      const outletId = Number(req.body.outlet_id);
      if (!outletId || !(await validateOutletId(outletId))) {
        return res.status(422).json({ success: false, message: "Outlet tidak valid" });
      }
      updates.push("outlet_id = ?");
      params.push(outletId);
    }

    const hasCheckIn = "check_in_time" in req.body;
    const hasCheckOut = "check_out_time" in req.body;
    let finalCheckIn = row.check_in_time;
    let finalCheckOut = row.check_out_time;

    if (hasCheckIn) {
      const raw = req.body.check_in_time;
      finalCheckIn = raw === "" || raw === null ? null : toMySQLDatetime(raw);
      if (raw && raw !== "" && !finalCheckIn) {
        return res.status(422).json({ success: false, message: "Format jam masuk tidak valid" });
      }
      updates.push("check_in_time = ?");
      params.push(finalCheckIn);
    }

    if (hasCheckOut) {
      const raw = req.body.check_out_time;
      finalCheckOut = raw === "" || raw === null ? null : toMySQLDatetime(raw);
      if (raw && raw !== "" && !finalCheckOut) {
        return res.status(422).json({ success: false, message: "Format jam keluar tidak valid" });
      }
      updates.push("check_out_time = ?");
      params.push(finalCheckOut);
    }

    if (!updates.length) {
      return res.status(422).json({ success: false, message: "Tidak ada field yang diubah" });
    }

    if (finalCheckIn && finalCheckOut && new Date(finalCheckOut) <= new Date(finalCheckIn)) {
      return res.status(422).json({ success: false, message: "Jam keluar harus lebih besar dari jam masuk" });
    }

    params.push(id);
    await safeMyWaschenQuery(
      `UPDATE tr_attendance SET ${updates.join(", ")} WHERE attendance_id = ?`,
      params,
    );

    const [rows] = await safeMyWaschenQuery(
      `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
              a.check_in_time, a.check_in_lat, a.check_in_lng,
              a.check_in_photo_path, a.check_in_photo_name,
              a.check_out_time, a.check_out_lat, a.check_out_lng,
              a.check_out_photo_path, a.check_out_photo_name
       FROM tr_attendance a WHERE a.attendance_id = ? LIMIT 1`,
      [id],
    );

    const empMap = await getEmployeeNameMap([rows[0].employee_id]);
    const roleMap = await getEmployeeRoleMap([rows[0].employee_id]);
    const photoCountMap = await getGroomingPhotoCountMap([rows[0].attendance_id]);
    return res.json({
      success: true,
      message: "Absensi berhasil diperbarui",
      data: mapAttendanceRow(req, rows[0], empMap, roleMap, photoCountMap),
    });
  } catch (err) {
    console.error("updateAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memperbarui absensi" });
  }
};



export const deleteAttendance = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "ID absensi tidak valid" });

    const [existing] = await safeMyWaschenQuery(
      `SELECT attendance_id, check_in_photo_name, check_out_photo_name FROM tr_attendance WHERE attendance_id = ? LIMIT 1`,
      [id],
    );
    if (!existing.length) {
      return res.status(404).json({ success: false, message: "Data absensi tidak ditemukan" });
    }

    await tryDeleteAttendancePhoto(existing[0].check_in_photo_name);
    await tryDeleteAttendancePhoto(existing[0].check_out_photo_name);

    try {
      const [gPhotos] = await safeMyWaschenQuery(
        `SELECT photo_name FROM tr_attendance_grooming_photo WHERE attendance_id = ?`,
        [id],
      );
      for (const gp of gPhotos) {
        await tryDeleteTypedPhoto("grooming", gp.photo_name);
      }
      await safeMyWaschenQuery(`DELETE FROM tr_attendance_grooming_photo WHERE attendance_id = ?`, [id]);

      const [cPhotos] = await safeMyWaschenQuery(
        `SELECT photo_name FROM tr_attendance_cleanliness_photo WHERE attendance_id = ?`,
        [id],
      );
      for (const cp of cPhotos) {
        await tryDeleteTypedPhoto("cleanliness", cp.photo_name);
      }
      await safeMyWaschenQuery(`DELETE FROM tr_attendance_cleanliness_photo WHERE attendance_id = ?`, [id]);
    } catch (_) { /* schema opsional */ }

    await safeMyWaschenQuery(`DELETE FROM tr_attendance WHERE attendance_id = ?`, [id]);

    return res.json({ success: true, message: "Absensi berhasil dihapus" });
  } catch (err) {
    console.error("deleteAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal menghapus absensi" });
  }
};

const GROOMING_STEP_LABEL = {
  depan_setengah: "Tampak Depan - Setengah Badan",
  closeup_wajah: "Close-Up Wajah",
  samping: "Tampak Samping",
  belakang: "Tampak Belakang",
  celana: "Tampilan Celana",
  kuku: "Close-Up Kuku",
};

async function tryDeleteTypedPhoto(type, photoName) {
  if (!photoName) return;
  const base = (process.env.WASCHEN_MOBILE_API_URL || "").replace(/\/$/, "");
  if (!base) return;
  const secret =
    process.env.WASCHEN_MOBILE_REALTIME_SECRET ||
    process.env.REALTIME_SECRET ||
    process.env.SESSION_SECRET ||
    "waschensecret";
  try {
    await fetch(`${base}/api/realtime/delete-upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Realtime-Secret": secret,
      },
      body: JSON.stringify({ type, fileName: photoName }),
    });
  } catch (err) {
    console.warn("[tryDeleteTypedPhoto] remote skip:", err?.message || err);
  }
}

/** GET /waschen/hris/attendance/:id/detail — grooming + kebersihan untuk modal eye */
export const getAttendanceDetail = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "ID absensi tidak valid" });

    let rows;
    try {
      [rows] = await safeMyWaschenQuery(
        `SELECT a.*, r.role AS role_code, r.employee_name AS role_employee_name
         FROM tr_attendance a
         LEFT JOIN mst_role r ON r.employee_id = a.employee_id
         WHERE a.attendance_id = ?
         LIMIT 1`,
        [id],
      );
    } catch (_) {
      [rows] = await safeMyWaschenQuery(
        `SELECT * FROM tr_attendance WHERE attendance_id = ? LIMIT 1`,
        [id],
      );
    }

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Data absensi tidak ditemukan" });
    }

    const att = rows[0];
    const empMap = await getEmployeeNameMap([att.employee_id]);
    const roleMap = await getEmployeeRoleMap([att.employee_id]);
    const photoCountMap = await getGroomingPhotoCountMap([att.attendance_id]);
    const base = mapAttendanceRow(req, att, empMap, roleMap, photoCountMap);

    let groomingPhotos = [];
    try {
      const [gps] = await safeMyWaschenQuery(
        `SELECT grooming_photo_id, step_code, photo_path, photo_name, taken_at, taken_by_name
         FROM tr_attendance_grooming_photo
         WHERE attendance_id = ?
         ORDER BY grooming_photo_id ASC`,
        [id],
      );
      groomingPhotos = gps.map((p) => ({
        id: p.grooming_photo_id,
        step_code: p.step_code,
        step_label: GROOMING_STEP_LABEL[p.step_code] || p.step_code,
        url: buildAttendancePhotoUrl(req, p.photo_path, p.photo_name),
        taken_at: p.taken_at,
        taken_by_name: p.taken_by_name,
      }));
    } catch (_) { /* optional */ }

    let cleanlinessPhotos = [];
    try {
      const roleCode = att.role_code || null;
      const workDate = toISODate(att.work_date);
      if (att.outlet_id && roleCode && workDate) {
        const [cps] = await safeMyWaschenQuery(
          `SELECT cleanliness_photo_id, uploaded_by_name, photo_path, photo_name, taken_at, role_code
           FROM tr_attendance_cleanliness_photo
           WHERE outlet_id = ? AND role_code = ? AND work_date = ?
           ORDER BY taken_at DESC`,
          [att.outlet_id, roleCode, workDate],
        );
        cleanlinessPhotos = cps.map((p) => ({
          id: p.cleanliness_photo_id,
          url: buildAttendancePhotoUrl(req, p.photo_path, p.photo_name),
          taken_at: p.taken_at,
          uploaded_by_name: p.uploaded_by_name,
          role_code: p.role_code,
        }));
      }
    } catch (_) { /* optional */ }

    return res.json({
      success: true,
      data: {
        ...base,
        role_code: att.role_code || null,
        grooming_photos: groomingPhotos,
        cleanliness_photos: cleanlinessPhotos,
      },
    });
  } catch (err) {
    console.error("getAttendanceDetail:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat detail absensi" });
  }
};

/** GET /waschen/hris/attendance/cleanliness — tab Kebersihan */
export const getCleanlinessList = async (req, res) => {
  try {
    const defaults = defaultCutoffDateRange();
    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;
    const endDate = toISODate(req.query.endDate) || defaults.dateTo;
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const role = req.query.role ? String(req.query.role).trim() : "";

    const cond = [];
    const params = [];
    if (startDate) {
      cond.push("c.work_date >= ?");
      params.push(startDate);
    }
    if (endDate) {
      cond.push("c.work_date <= ?");
      params.push(endDate);
    }
    if (outletId) {
      cond.push("c.outlet_id = ?");
      params.push(outletId);
    }
    if (role) {
      cond.push("c.role_code = ?");
      params.push(role);
    }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";

    let rows = [];
    try {
      const [r] = await safeMyWaschenQuery(
        `SELECT c.cleanliness_photo_id, c.outlet_id, c.work_date, c.role_code,
                c.uploaded_by_employee_id, c.uploaded_by_name,
                c.photo_path, c.photo_name, c.taken_at, c.attendance_id
         FROM tr_attendance_cleanliness_photo c
         ${where}
         ORDER BY c.work_date DESC, c.taken_at DESC
         LIMIT 500`,
        params,
      );
      rows = r;
    } catch (err) {
      if (err.code === "ER_NO_SUCH_TABLE") {
        return res.json({ success: true, data: [] });
      }
      throw err;
    }

    const data = rows.map((p) => ({
      cleanliness_photo_id: p.cleanliness_photo_id,
      outlet_id: p.outlet_id,
      work_date: toISODate(p.work_date),
      role_code: p.role_code,
      uploaded_by_employee_id: p.uploaded_by_employee_id,
      uploaded_by_name: p.uploaded_by_name,
      taken_at: p.taken_at,
      attendance_id: p.attendance_id,
      photo_url: buildAttendancePhotoUrl(req, p.photo_path, p.photo_name),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    console.error("getCleanlinessList:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat foto kebersihan" });
  }
};

