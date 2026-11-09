import { safeMyWaschenQuery } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getEmployeeNameMap, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause } from "./hrisHelpers.js";

import { buildLeaveDocUrl } from "./hrisAssetHelpers.js";

import { notifyWaschenRealtime } from "../../../utils/notifyWaschenRealtime.js";



export const getLeaveList = async (req, res) => {

  try {

    const defaults = defaultCutoffDateRange();

    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;

    const endDate = toISODate(req.query.endDate) || defaults.dateTo;

    const status = req.query.status ? String(req.query.status) : "";

    const leaveType = req.query.leaveType ? String(req.query.leaveType) : "";

    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    // Multi-pilih: outletId=1,2 & role=Frontliner,Produksi (diurai resolveMstRoleEmployeeIds)
    const outletId = req.query.outletId || null;

    const role = req.query.role || "";

    const search = String(req.query.search || "").trim();



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

      cond.push("l.end_date >= ?");

      params.push(startDate);

    }

    if (endDate) {

      cond.push("l.start_date <= ?");

      params.push(endDate);

    }

    if (status && status !== "Semua") {

      cond.push("l.status = ?");

      params.push(status.toLowerCase());

    }

    if (leaveType && leaveType !== "Semua") {

      cond.push("l.leave_type = ?");

      params.push(leaveType.toLowerCase());

    }

    if (employeeId) {

      cond.push("l.employee_id = ?");

      params.push(employeeId);

    }

    appendEmployeeIdInClause(cond, params, roleEmployeeIds, "l.employee_id");



    const [rows] = await safeMyWaschenQuery(

      `SELECT l.* FROM tr_leave l

       WHERE ${cond.join(" AND ")}

       ORDER BY l.created_at DESC

       LIMIT 1000`,

      params,

    );



    const empMap = await getEmployeeNameMap(rows.map((r) => r.employee_id));

    let items = rows.map((r) => ({

      ...r,

      start_date: toISODate(r.start_date),

      end_date: toISODate(r.end_date),

      employee_name: empMap.get(Number(r.employee_id))?.full_name || `#${r.employee_id}`,

      employee_code: empMap.get(Number(r.employee_id))?.employee_code || null,

      doctor_note_url: buildLeaveDocUrl(req, r.doctor_note_path, r.doctor_note_name),

    }));



    if (search) {

      const kw = search.toLowerCase();

      items = items.filter(

        (r) =>

          r.employee_name?.toLowerCase().includes(kw) ||

          r.reason?.toLowerCase().includes(kw) ||

          r.leave_type?.toLowerCase().includes(kw) ||

          r.employee_code?.toLowerCase().includes(kw),

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

    console.error("getLeaveList:", err);

    return res.status(500).json({ success: false, message: err.message || "Gagal memuat perizinan" });

  }

};



function actorOf(req) {
  return {
    id: Number(req.user?.employee_id) || null,
    name: req.user?.full_name || req.user?.name || req.user?.email || "Admin",
  };
}

/** Best-effort: tabel tr_leave_log opsional (lihat agent/migrate_tr_leave_log.sql). */
async function writeLeaveLog(req, leaveId, action, fromStatus, note) {
  try {
    const a = actorOf(req);
    await safeMyWaschenQuery(
      `INSERT INTO tr_leave_log (leave_id, action, from_status, actor_employee_id, actor_name, note) VALUES (?, ?, ?, ?, ?, ?)`,
      [leaveId, action, fromStatus || null, a.id, a.name, note || null],
    );
  } catch (err) {
    if (err?.code !== "ER_NO_SUCH_TABLE") console.warn("writeLeaveLog:", err.message);
  }
}

export const approveLeave = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [before] = await safeMyWaschenQuery(`SELECT employee_id, status FROM tr_leave WHERE leave_id = ? LIMIT 1`, [id]);
    await safeMyWaschenQuery(
      `UPDATE tr_leave SET status = 'disetujui', rejection_note = NULL, updated_at = NOW() WHERE leave_id = ?`,
      [id],
    );
    await writeLeaveLog(req, id, "disetujui", before?.[0]?.status, null);
    await notifyWaschenRealtime({
      domain: "leave",
      employeeId: before?.[0]?.employee_id,
      action: "approve",
    });
    return res.json({ success: true, message: "Perizinan disetujui" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rejectLeave = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const note = String(req.body.rejection_note || req.body.note || "").trim();
    const [before] = await safeMyWaschenQuery(`SELECT employee_id, status FROM tr_leave WHERE leave_id = ? LIMIT 1`, [id]);
    const prevStatus = before?.[0]?.status;
    await safeMyWaschenQuery(
      `UPDATE tr_leave SET status = 'ditolak', rejection_note = ?, updated_at = NOW() WHERE leave_id = ?`,
      [note || "Ditolak admin", id],
    );
    await writeLeaveLog(req, id, prevStatus === "disetujui" ? "dianulir" : "ditolak", prevStatus, note || "Ditolak admin");
    await notifyWaschenRealtime({
      domain: "leave",
      employeeId: before?.[0]?.employee_id,
      action: "reject",
    });
    return res.json({ success: true, message: "Perizinan ditolak" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/hris/leaves/:id/log — rincian + riwayat aktivitas satu perizinan */
export const getLeaveLog = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await safeMyWaschenQuery(`SELECT * FROM tr_leave WHERE leave_id = ? LIMIT 1`, [id]);
    const leave = rows?.[0];
    if (!leave) return res.status(404).json({ success: false, message: "Perizinan tidak ditemukan" });

    let logs = [];
    try {
      const [logRows] = await safeMyWaschenQuery(
        `SELECT log_id, action, from_status, actor_employee_id, actor_name, note, created_at FROM tr_leave_log WHERE leave_id = ? ORDER BY created_at, log_id`,
        [id],
      );
      logs = logRows;
    } catch (err) {
      if (err?.code !== "ER_NO_SUCH_TABLE") throw err;
    }

    const empMap = await getEmployeeNameMap([leave.employee_id, ...logs.map((l) => l.actor_employee_id)]);
    const emp = empMap.get(Number(leave.employee_id));
    const employeeName = emp?.full_name || `#${leave.employee_id}`;

    const events = [{ type: "diajukan", at: leave.created_at, actor: employeeName, note: leave.reason, tracked: true }];
    logs.forEach((l) =>
      events.push({
        type: l.action,
        at: l.created_at,
        actor: l.actor_name || empMap.get(Number(l.actor_employee_id))?.full_name || null,
        note: l.note || null,
        tracked: true,
      }),
    );
    // Keputusan lama sebelum log ada: waktu = updated_at terakhir, pelaku tidak tercatat.
    if (leave.status !== "pengajuan" && !logs.length) {
      events.push({
        type: leave.status === "disetujui" ? "disetujui" : "ditolak",
        at: leave.updated_at,
        actor: null,
        note: leave.rejection_note || null,
        tracked: false,
      });
    }

    return res.json({
      success: true,
      data: {
        leave: {
          ...leave,
          start_date: toISODate(leave.start_date),
          end_date: toISODate(leave.end_date),
          employee_name: employeeName,
          employee_code: emp?.employee_code || null,
          doctor_note_url: buildLeaveDocUrl(req, leave.doctor_note_path, leave.doctor_note_name),
        },
        events,
      },
    });
  } catch (err) {
    console.error("getLeaveLog:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat log perizinan" });
  }
};
