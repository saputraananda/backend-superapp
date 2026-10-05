import { safeCleanoxQuery } from "../../../db/pool.js";

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function eachDateInclusive(startDate, endDate) {
  const out = [];
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function normalizeIds(workerIds) {
  return [...new Set((workerIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

/**
 * @returns {Promise<Map<number, Set<string>>>}
 */
export async function getOffDayMap(workerIds, startDate, endDate) {
  const ids = normalizeIds(workerIds);
  const map = new Map();
  if (ids.length === 0) return map;

  const [rows] = await safeCleanoxQuery(
    `
      SELECT worker_id, off_date
      FROM tr_worker_off_days
      WHERE worker_id IN (${ids.map(() => "?").join(",")})
        AND off_date >= ?
        AND off_date <= ?
    `,
    [...ids, startDate, endDate]
  );

  for (const row of rows || []) {
    const wid = Number(row.worker_id);
    if (!map.has(wid)) map.set(wid, new Set());
    map.get(wid).add(toDateOnly(row.off_date));
  }
  return map;
}

/**
 * Cuti/izin berstatus disetujui, di-expand per tanggal dalam rentang.
 * @returns {Promise<Map<number, Map<string, string>>>}
 */
export async function getApprovedLeaveMap(workerIds, startDate, endDate) {
  const ids = normalizeIds(workerIds);
  const map = new Map();
  if (ids.length === 0) return map;

  const [rows] = await safeCleanoxQuery(
    `
      SELECT worker_id, leave_type, start_date, end_date
      FROM tr_worker_leaves
      WHERE worker_id IN (${ids.map(() => "?").join(",")})
        AND status = 'disetujui'
        AND start_date <= ?
        AND end_date >= ?
    `,
    [...ids, endDate, startDate]
  );

  for (const row of rows || []) {
    const wid = Number(row.worker_id);
    const from = toDateOnly(row.start_date);
    const to = toDateOnly(row.end_date);
    if (!from || !to) continue;
    const clippedStart = from < startDate ? startDate : from;
    const clippedEnd = to > endDate ? endDate : to;
    if (clippedStart > clippedEnd) continue;
    if (!map.has(wid)) map.set(wid, new Map());
    for (const d of eachDateInclusive(clippedStart, clippedEnd)) {
      map.get(wid).set(d, row.leave_type || "cuti");
    }
  }
  return map;
}
