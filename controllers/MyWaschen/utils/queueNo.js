/**
 * Nomor urut nota per outlet per hari ("#1", "#2", ...) — urutan id pada tanggal order yang sama.
 * `query` = fungsi (sql, params) → [rows], mis. safeMyWaschenQuery. Dihitung dengan 2 query ringan (lookup PK + 1 range scan idx_order_date), BUKAN subquery per baris:
 * COUNT berkorelasi di tr_transaction (100rb+ baris) membuat daftar nota butuh puluhan detik.
 */
const MAX_SPAN_DAYS = 62;

export async function attachQueueNo(query, rows) {
  const list = (rows || []).filter((r) => r && r.id);
  list.forEach((r) => { r.queue_no = null; });
  if (!list.length) return rows;

  const ids = [...new Set(list.map((r) => r.id))];
  const [meta] = await query(
    `SELECT id, outlet_id, DATE_FORMAT(order_date, '%Y-%m-%d') AS d FROM tr_transaction WHERE id IN (?)`,
    [ids]
  );
  if (!meta.length) return rows;

  const days = meta.map((m) => m.d).filter(Boolean).sort();
  if (!days.length) return rows;
  const minDay = days[0];
  const maxDay = days[days.length - 1];
  const span = (Date.parse(maxDay) - Date.parse(minDay)) / 86400000;
  if (span > MAX_SPAN_DAYS) return rows;

  const [dayRows] = await query(
    `SELECT id, outlet_id, DATE_FORMAT(order_date, '%Y-%m-%d') AS d
     FROM tr_transaction FORCE INDEX (idx_order_date)
     WHERE order_date >= ? AND order_date < DATE_ADD(?, INTERVAL 1 DAY)
     ORDER BY id`,
    [`${minDay} 00:00:00`, `${maxDay} 00:00:00`]
  );

  const counter = new Map();
  const queueById = new Map();
  for (const r of dayRows) {
    const key = `${r.outlet_id}|${r.d}`;
    const n = (counter.get(key) || 0) + 1;
    counter.set(key, n);
    queueById.set(r.id, n);
  }
  list.forEach((r) => { r.queue_no = queueById.get(r.id) ?? null; });
  return rows;
}
