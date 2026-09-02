import { safeMyWaschenQuery } from "../../../db/pool.js";
import { defaultCutoffDateRange } from "../cutoffHelpers.js";
import { getActor, getEmployeeNameMap, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause } from "./hrisHelpers.js";

export const getDayOffList = async (req, res) => {
  try {
    const defaults = defaultCutoffDateRange();
    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;
    const endDate = toISODate(req.query.endDate) || defaults.dateTo;
    const status = req.query.status ? String(req.query.status) : "";
    const search = String(req.query.search || "").trim().toLowerCase();
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const role = req.query.role ? String(req.query.role).trim() : "";

    const roleEmployeeIds = await resolveMstRoleEmployeeIds(outletId, role);
    if (roleEmployeeIds && roleEmployeeIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        summary: { total: 0, pengajuan: 0, disetujui: 0, ditolak: 0 },
      });
    }

    const cond = ["1=1"];
    const params = [];
    if (startDate) {
      cond.push("d.off_date >= ?");
      params.push(startDate);
    }
    if (endDate) {
      cond.push("d.off_date <= ?");
      params.push(endDate);
    }
    if (status && status !== "Semua") {
      cond.push("d.status = ?");
      params.push(status.toLowerCase());
    }
    if (employeeId) {
      cond.push("d.employee_id = ?");
      params.push(employeeId);
    }
    appendEmployeeIdInClause(cond, params, roleEmployeeIds, "d.employee_id");

    const [rows] = await safeMyWaschenQuery(
      `SELECT d.* FROM tr_employee_day_off d
       WHERE ${cond.join(" AND ")}
       ORDER BY d.off_date DESC, d.created_at DESC
       LIMIT 500`,
      params,
    );

    const empMap = await getEmployeeNameMap(rows.map((r) => r.employee_id));
    let items = rows.map((r) => ({
      ...r,
      off_date: toISODate(r.off_date),
      requested_date: toISODate(r.requested_date),
      employee_name: empMap.get(Number(r.employee_id))?.full_name || `#${r.employee_id}`,
      employee_code: empMap.get(Number(r.employee_id))?.employee_code || null,
    }));

    if (search) {
      items = items.filter(
        (r) =>
          r.employee_name?.toLowerCase().includes(search) ||
          r.reason?.toLowerCase().includes(search) ||
          r.employee_code?.toLowerCase().includes(search),
      );
    }

    const summary = {
      total: items.length,
      pengajuan: items.filter((r) => r.status === "pengajuan").length,
      disetujui: items.filter((r) => r.status === "disetujui").length,
      ditolak: items.filter((r) => r.status === "ditolak").length,
    };

    return res.json({ success: true, data: items, summary });
  } catch (err) {
    console.error("getDayOffList:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat jadwal libur" });
  }
};

export const adminAssignDayOff = async (req, res) => {
  try {
    const actor = getActor(req);
    const employeeId = Number(req.body.employee_id);
    const offDate = toISODate(req.body.off_date);
    const reason = String(req.body.reason || "").trim();
    if (!employeeId || !offDate || !reason) {
      return res.status(422).json({ success: false, message: "Karyawan, tanggal, dan alasan wajib" });
    }
    const d = new Date(`${offDate}T12:00:00`);
    const scheduleYear = d.getFullYear();
    const scheduleMonth = d.getMonth() + 1;

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO tr_employee_day_off
       (employee_id, off_date, schedule_year, schedule_month, reason, status, source, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'disetujui', 'admin', ?, NOW())`,
      [employeeId, offDate, scheduleYear, scheduleMonth, reason, actor.employee_id],
    );

    await safeMyWaschenQuery(
      `INSERT INTO tr_day_off_change_log (day_off_id, employee_id, action, old_off_date, new_off_date, note, changed_by)
       VALUES (?, ?, 'admin_assign', NULL, ?, ?, ?)`,
      [result.insertId, employeeId, offDate, reason, actor.employee_id || 0],
    );

    return res.status(201).json({ success: true, message: "Jadwal libur ditetapkan" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Tanggal libur sudah ada untuk karyawan ini" });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const approveDayOff = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = Number(req.params.id);
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_employee_day_off WHERE day_off_id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });

    await safeMyWaschenQuery(
      `UPDATE tr_employee_day_off SET status = 'disetujui', reviewed_by = ?, reviewed_at = NOW() WHERE day_off_id = ?`,
      [actor.employee_id, id],
    );
    await safeMyWaschenQuery(
      `INSERT INTO tr_day_off_change_log (day_off_id, employee_id, action, old_off_date, new_off_date, note, changed_by)
       VALUES (?, ?, 'approve', ?, ?, 'Disetujui admin', ?)`,
      [id, rows[0].employee_id, rows[0].off_date, rows[0].off_date, actor.employee_id || 0],
    );
    return res.json({ success: true, message: "Permintaan libur disetujui" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rejectDayOff = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = Number(req.params.id);
    const note = String(req.body.rejection_note || req.body.note || "").trim();
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_employee_day_off WHERE day_off_id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });

    await safeMyWaschenQuery(
      `UPDATE tr_employee_day_off SET status = 'ditolak', rejection_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE day_off_id = ?`,
      [note || "Ditolak admin", actor.employee_id, id],
    );
    await safeMyWaschenQuery(
      `INSERT INTO tr_day_off_change_log (day_off_id, employee_id, action, old_off_date, new_off_date, note, changed_by)
       VALUES (?, ?, 'reject', ?, NULL, ?, ?)`,
      [id, rows[0].employee_id, rows[0].off_date, note || "Ditolak admin", actor.employee_id || 0],
    );
    return res.json({ success: true, message: "Permintaan libur ditolak" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rescheduleDayOff = async (req, res) => {
  try {
    const actor = getActor(req);
    const id = Number(req.params.id);
    const newDate = toISODate(req.body.new_off_date);
    const note = String(req.body.note || "").trim();
    if (!newDate) return res.status(422).json({ success: false, message: "Tanggal baru wajib" });

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_employee_day_off WHERE day_off_id = ?", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    const row = rows[0];

    const d = new Date(`${newDate}T12:00:00`);
    const scheduleYear = d.getFullYear();
    const scheduleMonth = d.getMonth() + 1;
    const requestedDate = row.requested_date || row.off_date;

    await safeMyWaschenQuery(
      `UPDATE tr_employee_day_off
       SET off_date = ?, requested_date = ?, schedule_year = ?, schedule_month = ?,
           status = 'disetujui', reviewed_by = ?, reviewed_at = NOW()
       WHERE day_off_id = ?`,
      [newDate, toISODate(requestedDate), scheduleYear, scheduleMonth, actor.employee_id, id],
    );
    await safeMyWaschenQuery(
      `INSERT INTO tr_day_off_change_log (day_off_id, employee_id, action, old_off_date, new_off_date, note, changed_by)
       VALUES (?, ?, 'reschedule', ?, ?, ?, ?)`,
      [id, row.employee_id, row.off_date, newDate, note || "Reschedule admin", actor.employee_id || 0],
    );
    return res.json({ success: true, message: "Jadwal libur dipindahkan" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Tanggal baru bentrok dengan jadwal lain" });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};
