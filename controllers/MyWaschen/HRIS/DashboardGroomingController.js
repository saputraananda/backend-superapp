import { safeMyWaschenQuery } from "../../../db/pool.js";
import { defaultCutoffDateRange } from "../cutoffHelpers.js";
import { getEmployeeNameMap, toISODate } from "./hrisHelpers.js";
import { buildAttendancePhotoUrl } from "./hrisAssetHelpers.js";

const GROOMING_ROLES = ["Frontliner", "Delivery Staff"];
const STEPS = [
  { code: "depan_setengah", label: "Tampak Depan - Setengah Badan" },
  { code: "closeup_wajah", label: "Close-Up Wajah" },
  { code: "samping", label: "Tampak Samping" },
  { code: "belakang", label: "Tampak Belakang" },
  { code: "celana", label: "Tampilan Celana" },
  { code: "kuku", label: "Close-Up Kuku" },
];

const emptyBody = {
  success: true,
  steps: STEPS,
  summary: {
    employees: 0,
    days: 0,
    lengkap: 0,
    kurang: 0,
    kosong: 0,
    belum_foto_people: 0,
    belum_lengkap_people: 0,
    lengkap_people: 0,
    discipline_pct: 0,
  },
  employees: [],
};

function statusOf(count) {
  if (count >= STEPS.length) return "lengkap";
  if (count === 0) return "kosong";
  return "kurang";
}

/** GET /waschen/hris/attendance/grooming-dashboard */
export const getGroomingDashboard = async (req, res) => {
  try {
    const defaults = defaultCutoffDateRange();
    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;
    const endDate = toISODate(req.query.endDate) || defaults.dateTo;
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const role = req.query.role ? String(req.query.role).trim() : "";

    const roles = role
      ? (GROOMING_ROLES.includes(role) ? [role] : [])
      : GROOMING_ROLES;
    if (!roles.length) return res.json(emptyBody);

    const rolePh = roles.map(() => "?").join(",");
    const cond = ["a.work_date >= ?", "a.work_date <= ?", `r.role IN (${rolePh})`];
    const params = [startDate, endDate, ...roles];
    if (outletId) {
      cond.push("a.outlet_id = ?");
      params.push(outletId);
    }

    let att = [];
    try {
      const [rows] = await safeMyWaschenQuery(
        `SELECT a.attendance_id, a.employee_id, a.outlet_id, a.work_date,
                a.grooming_incomplete_reason, r.role AS role_code
         FROM tr_attendance a
         INNER JOIN mst_role r ON r.employee_id = a.employee_id
         WHERE ${cond.join(" AND ")}
         ORDER BY a.work_date DESC, a.employee_id ASC`,
        params,
      );
      att = rows;
    } catch (err) {
      if (err.code === "ER_NO_SUCH_TABLE") return res.json(emptyBody);
      throw err;
    }

    const ids = att.map((a) => a.attendance_id);
    const byAtt = new Map();
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      try {
        const [photos] = await safeMyWaschenQuery(
          `SELECT attendance_id, step_code, photo_path, photo_name, taken_at
           FROM tr_attendance_grooming_photo
           WHERE attendance_id IN (${ph})
           ORDER BY grooming_photo_id ASC`,
          ids,
        );
        photos.forEach((p) => {
          const k = Number(p.attendance_id);
          if (!byAtt.has(k)) byAtt.set(k, []);
          byAtt.get(k).push(p);
        });
      } catch (err) {
        if (err.code !== "ER_NO_SUCH_TABLE") throw err;
      }
    }

    const empMap = await getEmployeeNameMap(att.map((a) => a.employee_id));
    const byEmp = new Map();
    att.forEach((a) => {
      const eid = Number(a.employee_id);
      if (!byEmp.has(eid)) {
        const info = empMap.get(eid);
        byEmp.set(eid, {
          employee_id: eid,
          employee_name: info?.full_name || `#${eid}`,
          employee_code: info?.employee_code || null,
          role_code: a.role_code,
          days: [],
        });
      }
      const list = byAtt.get(Number(a.attendance_id)) || [];
      const have = new Map(list.map((p) => [p.step_code, p]));
      byEmp.get(eid).days.push({
        attendance_id: a.attendance_id,
        work_date: toISODate(a.work_date),
        outlet_id: a.outlet_id,
        status: statusOf(list.length),
        photo_count: list.length,
        reason: a.grooming_incomplete_reason || null,
        photos: STEPS.map((s) => {
          const p = have.get(s.code);
          return {
            step_code: s.code,
            step_label: s.label,
            url: p ? buildAttendancePhotoUrl(req, p.photo_path, p.photo_name) : null,
            taken_at: p?.taken_at || null,
          };
        }),
      });
    });

    const employees = [...byEmp.values()].map((e) => {
      const lengkap = e.days.filter((d) => d.status === "lengkap").length;
      const kurang = e.days.filter((d) => d.status === "kurang").length;
      const kosong = e.days.filter((d) => d.status === "kosong").length;
      const days = e.days.length;
      return {
        ...e,
        days_count: days,
        lengkap,
        kurang,
        kosong,
        discipline_pct: days ? Math.round((lengkap / days) * 100) : 0,
      };
    }).sort((a, b) => a.discipline_pct - b.discipline_pct || b.kosong - a.kosong || a.employee_name.localeCompare(b.employee_name, "id"));

    const dayTotal = employees.reduce((s, e) => s + e.days_count, 0);
    const lengkap = employees.reduce((s, e) => s + e.lengkap, 0);
    const kurang = employees.reduce((s, e) => s + e.kurang, 0);
    const kosong = employees.reduce((s, e) => s + e.kosong, 0);

    return res.json({
      success: true,
      steps: STEPS,
      summary: {
        employees: employees.length,
        days: dayTotal,
        lengkap,
        kurang,
        kosong,
        belum_foto_people: employees.filter((e) => e.kosong > 0).length,
        belum_lengkap_people: employees.filter((e) => e.kurang > 0).length,
        lengkap_people: employees.filter((e) => e.days_count > 0 && e.lengkap === e.days_count).length,
        discipline_pct: dayTotal ? Math.round((lengkap / dayTotal) * 100) : 0,
      },
      employees,
    });
  } catch (err) {
    console.error("getGroomingDashboard:", err);
    return res.status(500).json({ success: false, message: "Gagal memuat dashboard grooming" });
  }
};
