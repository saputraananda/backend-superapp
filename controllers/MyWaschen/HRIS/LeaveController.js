import { safeMyWaschenQuery } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getEmployeeNameMap, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause } from "./hrisHelpers.js";

import { buildLeaveDocUrl } from "./hrisAssetHelpers.js";



export const getLeaveList = async (req, res) => {

  try {

    const defaults = defaultCutoffDateRange();

    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;

    const endDate = toISODate(req.query.endDate) || defaults.dateTo;

    const status = req.query.status ? String(req.query.status) : "";

    const leaveType = req.query.leaveType ? String(req.query.leaveType) : "";

    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    const outletId = req.query.outletId ? Number(req.query.outletId) : null;

    const role = req.query.role ? String(req.query.role).trim() : "";

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



export const approveLeave = async (req, res) => {

  try {

    const id = Number(req.params.id);

    await safeMyWaschenQuery(

      `UPDATE tr_leave SET status = 'disetujui', rejection_note = NULL, updated_at = NOW() WHERE leave_id = ?`,

      [id],

    );

    return res.json({ success: true, message: "Perizinan disetujui" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const rejectLeave = async (req, res) => {

  try {

    const id = Number(req.params.id);

    const note = String(req.body.rejection_note || req.body.note || "").trim();

    await safeMyWaschenQuery(

      `UPDATE tr_leave SET status = 'ditolak', rejection_note = ?, updated_at = NOW() WHERE leave_id = ?`,

      [note || "Ditolak admin", id],

    );

    return res.json({ success: true, message: "Perizinan ditolak" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};


