import { safeQuery, safeMyWaschenQuery } from "../../../db/pool.js";

export const WASCHEN_ROLE_VALUES = [
  "Frontliner",
  "Washing Staff",
  "Ironing Staff",
  "Packing Staff",
  "Delivery Staff",
];

export function toISODate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function getActor(req) {
  const user = req.session?.user || {};
  const emp = user.employee || {};
  return {
    employee_id: Number(emp.employee_id || user.employee_id || 0) || null,
    name:
      String(user.name || emp.full_name || user.username || "Admin").trim() ||
      "Admin",
  };
}

export async function getEmployeeNameMap(employeeIds = []) {
  const ids = [...new Set(employeeIds.map(Number).filter((id) => id > 0))];
  const map = new Map();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name, employee_code FROM mst_employee WHERE employee_id IN (${placeholders})`,
    ids,
  );
  rows.forEach((r) => map.set(Number(r.employee_id), r));
  return map;
}

export async function getWaschenEmployeeIds() {
  const [rows] = await safeQuery(
    `SELECT employee_id FROM mst_employee WHERE company_id = 5 AND is_deleted = 0 AND exit_date IS NULL`,
  );
  return rows.map((r) => Number(r.employee_id));
}

/** Karyawan yang cocok filter outlet/bagian dari mst_role. null = tanpa filter. [] = tidak ada match. */
export async function resolveMstRoleEmployeeIds(outletId, role) {
  const outlet = outletId ? Number(outletId) : null;
  const roleStr = role ? String(role).trim() : "";
  if (!outlet && !roleStr) return null;

  const cond = [];
  const params = [];
  if (outlet) {
    cond.push("outlet_id = ?");
    params.push(outlet);
  }
  if (roleStr) {
    cond.push("role = ?");
    params.push(roleStr);
  }

  const [rows] = await safeMyWaschenQuery(
    `SELECT employee_id FROM mst_role WHERE ${cond.join(" AND ")}`,
    params,
  );
  return rows.map((r) => Number(r.employee_id));
}

export function appendEmployeeIdInClause(cond, params, employeeIds, column = "employee_id") {
  if (employeeIds == null) return;
  if (employeeIds.length === 0) {
    cond.push("1=0");
    return;
  }
  const ph = employeeIds.map(() => "?").join(",");
  cond.push(`${column} IN (${ph})`);
  params.push(...employeeIds);
}

/** YYYY-MM-DDTHH:MM atau YYYY-MM-DD HH:MM:SS → MySQL datetime */
export function toMySQLDatetime(value) {
  if (!value) return null;
  const normalized = String(value).replace("T", " ").slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(normalized)) return null;
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

export async function resolveEmployeeUserId(employeeId) {
  const [rows] = await safeQuery(
    `SELECT u.id FROM users u
     INNER JOIN mst_employee e ON e.email = u.email
     WHERE e.employee_id = ? LIMIT 1`,
    [employeeId],
  );
  if (rows[0]?.id) return Number(rows[0].id);
  return Number(employeeId);
}

export async function resolveEmployeeOutletId(employeeId, preferredOutletId) {
  if (preferredOutletId) return Number(preferredOutletId);
  const [rows] = await safeMyWaschenQuery(
    `SELECT outlet_id FROM mst_role WHERE employee_id = ? LIMIT 1`,
    [employeeId],
  );
  return rows[0]?.outlet_id ? Number(rows[0].outlet_id) : null;
}

export async function validateOutletId(outletId) {
  if (!outletId) return false;
  const [rows] = await safeQuery(`SELECT id FROM mst_outlet WHERE id = ? LIMIT 1`, [outletId]);
  return rows.length > 0;
}
