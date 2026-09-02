import { safeMyWaschenQuery } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getEmployeeNameMap, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause, toMySQLDatetime, resolveEmployeeUserId, resolveEmployeeOutletId, validateOutletId } from "./hrisHelpers.js";

import { buildAttendancePhotoUrl } from "./hrisAssetHelpers.js";

import fs from "fs";
import path from "path";



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



function tryDeleteAttendancePhoto(photoName) {
  const dir = process.env.WASCHEN_MOBILE_ATTENDANCE_DIR;
  if (!dir || !photoName) return;
  try {
    const fp = path.join(dir, photoName);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {
    /* ignore */
  }
}



function mapAttendanceRow(req, r, empMap) {
  const statusLabel = attendanceStatusLabel(r);
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



    const [attRows] = await safeMyWaschenQuery(

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



    let attendance = attRows.map((r) => mapAttendanceRow(req, r, empMap));



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
    const [result] = await safeMyWaschenQuery(
      `INSERT INTO tr_attendance (user_id, employee_id, outlet_id, work_date, check_in_time, check_out_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, employeeId, outletId, workDate, checkInTime, checkOutTime],
    );

    const [rows] = await safeMyWaschenQuery(
      `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
              a.check_in_time, a.check_in_lat, a.check_in_lng,
              a.check_in_photo_path, a.check_in_photo_name,
              a.check_out_time, a.check_out_lat, a.check_out_lng,
              a.check_out_photo_path, a.check_out_photo_name
       FROM tr_attendance a WHERE a.attendance_id = ? LIMIT 1`,
      [result.insertId],
    );

    const empMap = await getEmployeeNameMap([employeeId]);
    return res.status(201).json({
      success: true,
      message: "Absensi berhasil ditambahkan",
      data: mapAttendanceRow(req, rows[0], empMap),
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
    return res.json({
      success: true,
      message: "Absensi berhasil diperbarui",
      data: mapAttendanceRow(req, rows[0], empMap),
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

    tryDeleteAttendancePhoto(existing[0].check_in_photo_name);
    tryDeleteAttendancePhoto(existing[0].check_out_photo_name);

    await safeMyWaschenQuery(`DELETE FROM tr_attendance WHERE attendance_id = ?`, [id]);

    return res.json({ success: true, message: "Absensi berhasil dihapus" });
  } catch (err) {
    console.error("deleteAttendance:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal menghapus absensi" });
  }
};


