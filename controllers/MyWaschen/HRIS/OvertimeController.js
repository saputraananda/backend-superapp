import { safeMyWaschenQuery } from "../../../db/pool.js";
import { defaultCutoffDateRange } from "../cutoffHelpers.js";
import {
  getEmployeeNameMap,
  toISODate,
  resolveMstRoleEmployeeIds,
  appendEmployeeIdInClause,
} from "./hrisHelpers.js";
import { notifyWaschenRealtime } from "../../../utils/notifyWaschenRealtime.js";

/**
 * =============================================================================
 * MEMORY — LEMBUR Alsa HRIS (pantau + ACC/reject + detail pengerjaan)
 * =============================================================================
 * - Karyawan Start/Close di mobile → status 'berlangsung' lalu 'pengajuan'
 * - ACC/reject hanya untuk 'pengajuan' (bukan saat masih berlangsung)
 * - Filter style sama Perizinan/Kasbon (cutoff 26–25, outlet, role, status, search)
 * - Detail: item/nota di jendela start_at–end_at
 * =============================================================================
 */

const toTime = (v) => (v ? String(v).slice(0, 8) : null);
const toDateTime = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v).replace("T", " ").slice(0, 19);
};

const mapOt = (r, empMap) => ({
  ...r,
  overtime_date: toISODate(r.overtime_date),
  start_time: toTime(r.start_time),
  end_time: toTime(r.end_time),
  start_at: toDateTime(r.start_at),
  end_at: toDateTime(r.end_at),
  is_active: r.status === "berlangsung",
  employee_name: empMap.get(Number(r.employee_id))?.full_name || r.employee_name || `#${r.employee_id}`,
  employee_code: empMap.get(Number(r.employee_id))?.employee_code || null,
});

const reconcileOnApprove = async (overtimeId) => {
  await safeMyWaschenQuery(
    `UPDATE tr_item_progress
     SET work_time_flag = 'overtime'
     WHERE overtime_id = ? AND work_time_flag IN ('overtime_pending','overtime')`,
    [overtimeId],
  );
};

const reconcileOnReject = async (overtimeId) => {
  await safeMyWaschenQuery(
    `UPDATE tr_item_progress
     SET work_time_flag = 'outside_hours'
     WHERE overtime_id = ? AND work_time_flag IN ('overtime_pending','overtime')`,
    [overtimeId],
  );
};

export const getOvertimeList = async (req, res) => {
  try {
    const defaults = defaultCutoffDateRange();
    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;
    const endDate = toISODate(req.query.endDate) || defaults.dateTo;
    const status = req.query.status ? String(req.query.status) : "";
    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const role = req.query.role ? String(req.query.role).trim() : "";
    const search = String(req.query.search || "").trim();

    const roleEmployeeIds = await resolveMstRoleEmployeeIds(outletId, role);
    if (roleEmployeeIds && roleEmployeeIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        summary: { total: 0, berlangsung: 0, pengajuan: 0, disetujui: 0, ditolak: 0, dibatalkan: 0 },
      });
    }

    const cond = ["1=1"];
    const params = [];

    if (startDate) {
      cond.push("o.overtime_date >= ?");
      params.push(startDate);
    }
    if (endDate) {
      cond.push("o.overtime_date <= ?");
      params.push(endDate);
    }
    if (status && status !== "Semua") {
      cond.push("o.status = ?");
      params.push(status.toLowerCase());
    }
    if (employeeId) {
      cond.push("o.employee_id = ?");
      params.push(employeeId);
    }
    appendEmployeeIdInClause(cond, params, roleEmployeeIds, "o.employee_id");

    const [rows] = await safeMyWaschenQuery(
      `SELECT o.* FROM tr_overtime o
       WHERE ${cond.join(" AND ")}
       ORDER BY o.created_at DESC
       LIMIT 1000`,
      params,
    );

    const empMap = await getEmployeeNameMap(rows.map((r) => r.employee_id));
    let items = rows.map((r) => mapOt(r, empMap));

    if (search) {
      const kw = search.toLowerCase();
      items = items.filter(
        (r) =>
          r.employee_name?.toLowerCase().includes(kw) ||
          r.reason?.toLowerCase().includes(kw) ||
          r.employee_code?.toLowerCase().includes(kw) ||
          String(r.id).includes(kw),
      );
    }

    const summary = {
      total: items.length,
      berlangsung: items.filter((r) => r.status === "berlangsung").length,
      pengajuan: items.filter((r) => r.status === "pengajuan").length,
      disetujui: items.filter((r) => r.status === "disetujui").length,
      ditolak: items.filter((r) => r.status === "ditolak").length,
      dibatalkan: items.filter((r) => r.status === "dibatalkan").length,
    };

    return res.json({ success: true, data: items, summary });
  } catch (err) {
    console.error("getOvertimeList:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat lembur" });
  }
};

/**
 * GET /:id — detail + work items (nota, qty, stage, flag)
 */
export const getOvertimeDetail = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await safeMyWaschenQuery(`SELECT * FROM tr_overtime WHERE id = ? LIMIT 1`, [id]);
    const ot = rows?.[0];
    if (!ot) return res.status(404).json({ success: false, message: "Pengajuan tidak ditemukan" });

    const empMap = await getEmployeeNameMap([ot.employee_id]);
    const overtime = mapOt(ot, empMap);

    const [progressRows] = await safeMyWaschenQuery(
      `SELECT
         p.id AS progress_id,
         p.transaction_id,
         p.transaction_detail_id,
         p.stage,
         p.employee_id,
         p.employee_name,
         p.role_used,
         p.outlet_id,
         p.status AS progress_status,
         p.work_time_flag,
         p.overtime_id,
         p.completed_at,
         p.notes,
         t.order_no,
         t.barcode,
         c.name AS customer_name,
         d.service_name,
         d.qty,
         d.unit,
         cat.code AS category_code,
         COALESCE((
           SELECT SUM(b.qty_pcs) FROM tr_item_bag_detail b WHERE b.progress_id = p.id
         ), 0) AS bag_qty_pcs,
         COALESCE((
           SELECT SUM(pk.qty_pcs) FROM tr_item_packing pk WHERE pk.progress_id = p.id
         ), 0) AS packing_qty_pcs
       FROM tr_item_progress p
       LEFT JOIN tr_transaction t ON t.id = p.transaction_id
       LEFT JOIN mst_customer c ON c.id = t.customer_id
       LEFT JOIN tr_transaction_detail d ON d.id = p.transaction_detail_id
       LEFT JOIN mst_service s ON s.id = d.service_id
       LEFT JOIN mst_service_category cat ON cat.id = s.category_id
       WHERE p.overtime_id = ?
       ORDER BY p.completed_at ASC`,
      [id],
    );

    const workItems = (progressRows || []).map((r) => {
      const unit = String(r.unit || "").toLowerCase();
      const isKg = r.category_code === "KILOAN" || unit === "kg";
      return {
        ...r,
        qty_display: Number(r.qty) || 0,
        qty_unit: r.unit || (isKg ? "kg" : "pcs"),
        is_kg: isKg,
        pcs_worked: Number(r.bag_qty_pcs) || Number(r.packing_qty_pcs) || (isKg ? 0 : Number(r.qty) || 0),
        kg_worked: isKg ? Number(r.qty) || 0 : 0,
      };
    });

    const totals = workItems.reduce(
      (acc, w) => {
        acc.items += 1;
        acc.pcs += Number(w.pcs_worked) || 0;
        acc.kg += Number(w.kg_worked) || 0;
        if (w.work_time_flag === "overtime") acc.overtime += 1;
        if (w.work_time_flag === "overtime_pending") acc.pending += 1;
        if (w.work_time_flag === "outside_hours") acc.outside += 1;
        return acc;
      },
      { items: 0, pcs: 0, kg: 0, overtime: 0, pending: 0, outside: 0 },
    );

    return res.json({
      success: true,
      data: { overtime, work_items: workItems, totals },
    });
  } catch (err) {
    console.error("getOvertimeDetail:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const approveOvertime = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const note = String(req.body.approval_note || req.body.note || "").trim() || null;
    const reviewerName =
      req.user?.full_name || req.user?.name || req.user?.email || "Admin Alsa";

    const [rows] = await safeMyWaschenQuery(`SELECT * FROM tr_overtime WHERE id = ? LIMIT 1`, [id]);
    const ot = rows?.[0];
    if (!ot) return res.status(404).json({ success: false, message: "Pengajuan tidak ditemukan" });
    if (ot.status === "berlangsung") {
      return res.status(403).json({
        success: false,
        message: "Sesi masih berlangsung — karyawan harus close lembur dulu",
      });
    }
    if (ot.status !== "pengajuan") {
      return res.status(403).json({ success: false, message: "Hanya status pengajuan yang dapat disetujui" });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_overtime SET
         status = 'disetujui',
         approval_note = ?,
         rejection_note = NULL,
         reviewed_by = ?,
         reviewed_by_name = ?,
         reviewed_at = NOW(),
         updated_at = NOW()
       WHERE id = ?`,
      [note, req.user?.employee_id || null, reviewerName, id],
    );
    await reconcileOnApprove(id);
    await notifyWaschenRealtime({
      domain: "overtime",
      outletId: ot.outlet_id,
      employeeId: ot.employee_id,
      action: "approve",
    });
    return res.json({ success: true, message: "Lembur disetujui" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const rejectOvertime = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const note = String(req.body.rejection_note || req.body.note || "").trim();
    if (note.length < 3) {
      return res.status(422).json({ success: false, message: "Alasan penolakan wajib diisi" });
    }
    const reviewerName =
      req.user?.full_name || req.user?.name || req.user?.email || "Admin Alsa";

    const [rows] = await safeMyWaschenQuery(`SELECT * FROM tr_overtime WHERE id = ? LIMIT 1`, [id]);
    const ot = rows?.[0];
    if (!ot) return res.status(404).json({ success: false, message: "Pengajuan tidak ditemukan" });
    if (ot.status === "berlangsung") {
      return res.status(403).json({
        success: false,
        message: "Sesi masih berlangsung — karyawan harus close lembur dulu",
      });
    }
    if (ot.status !== "pengajuan") {
      return res.status(403).json({ success: false, message: "Hanya status pengajuan yang dapat ditolak" });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_overtime SET
         status = 'ditolak',
         rejection_note = ?,
         approval_note = NULL,
         reviewed_by = ?,
         reviewed_by_name = ?,
         reviewed_at = NOW(),
         updated_at = NOW()
       WHERE id = ?`,
      [note, req.user?.employee_id || null, reviewerName, id],
    );
    await reconcileOnReject(id);
    await notifyWaschenRealtime({
      domain: "overtime",
      outletId: ot.outlet_id,
      employeeId: ot.employee_id,
      action: "reject",
    });
    return res.json({ success: true, message: "Lembur ditolak" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
