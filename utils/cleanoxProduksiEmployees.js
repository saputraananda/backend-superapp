import { safeCleanoxQuery } from "../db/pool.js";

/**
 * Cleanox workers for Superapp operasional: mst_role.role = produksi only.
 * @returns {Promise<number[]>}
 */
export async function getCleanoxProduksiEmployeeIds() {
  const [rows] = await safeCleanoxQuery(
    `SELECT employee_id FROM mst_role WHERE role = 'produksi'`
  );
  return [
    ...new Set(
      (rows || [])
        .map((r) => Number(r.employee_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
}

/**
 * Map employee_id → 'produksi' (produksi rows only).
 * @returns {Promise<Map<number, string>>}
 */
export async function getCleanoxProduksiRoleMap() {
  const [rows] = await safeCleanoxQuery(
    `SELECT employee_id, role FROM mst_role WHERE role = 'produksi'`
  );
  const map = new Map();
  for (const r of rows || []) {
    const id = Number(r.employee_id);
    if (Number.isInteger(id) && id > 0) {
      map.set(id, r.role || "produksi");
    }
  }
  return map;
}

/**
 * Object-style role map (employee_id number keys) for controllers that used plain objects.
 * @returns {Promise<Record<number, string>>}
 */
export async function getCleanoxProduksiRoleMapObject() {
  const map = await getCleanoxProduksiRoleMap();
  const obj = {};
  for (const [id, role] of map.entries()) {
    obj[id] = role;
  }
  return obj;
}
