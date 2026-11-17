/**
 * Riwayat pengerjaan nota Smartlink (tr_smartlink_work_log, data lama — hanya dibaca).
 * Diubah ke bentuk yang sama dengan tr_item_progress supaya bisa tampil di "Alur Pengerjaan".
 *
 * File ini identik di AloraSuperApp/backend/utils, my-waschen-new/api/utils
 * dan waschen-mobile/api/utils — ubah ketiganya bersamaan.
 */

/** Tahap asli Smartlink → kunci tahap POS + label tampilan */
export const SMARTLINK_STAGES = {
  Order: { stage: "frontliner", label: "Order (Frontliner)" },
  Cuci: { stage: "washing", label: "Cuci" },
  Kering: { stage: "washing", label: "Kering" },
  Sortir: { stage: "washing", label: "Sortir" },
  Setrika: { stage: "ironing", label: "Setrika" },
  Pengemasan: { stage: "packing", label: "Pengemasan" },
  Finishing: { stage: "packing", label: "Finishing (Siap Diambil)" },
  Diambil: { stage: "handover", label: "Diambil Pelanggan" },
};

const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** Nota hasil migrasi Smartlink */
export function isSmartlinkTransaction(trx) {
  return String(trx?.source || "").toUpperCase() === "SMARTLINK";
}

/**
 * Ambil log Smartlink satu nota. Tabel belum ada (mis. DB lain) → [] tanpa error.
 * @param {(sql: string, params: any[]) => Promise<[any[]]>} query  pool.query myWaschen
 */
export async function fetchSmartlinkWorkLog(query, transactionId) {
  if (!transactionId) return [];
  try {
    const [rows] = await query(
      `SELECT id, transaction_id, transaction_detail_id, stage, status, employee_id, worker_name,
              service_name, qty, unit, notes, worked_at
       FROM tr_smartlink_work_log
       WHERE transaction_id = ?
       ORDER BY worked_at ASC, id ASC`,
      [transactionId]
    );
    return rows || [];
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err?.message || "")) return [];
    throw err;
  }
}

/** employee_id unik di log (untuk resolve nama dari mst_employee DB utama) */
export function smartlinkEmployeeIds(rows) {
  return [...new Set((rows || []).map((r) => Number(r.employee_id)).filter((n) => n > 0))];
}

/**
 * Kelompokkan log per transaction_detail_id, dalam bentuk mirip tr_item_progress.
 * Log tanpa detail: dipasangkan via nama layanan; nota 1 item → item itu; selain itu ke semua item.
 * @param {Array} details   baris tr_transaction_detail (butuh id, service_name)
 * @param {Array} rows      hasil fetchSmartlinkWorkLog
 * @param {(id:number)=>string|null} nameOf  nama karyawan dari employee_id
 * @param {Set<number>|null} allDetailIds  semua id detail nota. Diisi bila `details` hanya sebagian
 *        (mis. filter item produksi / outlet): log milik item yang tidak ditampilkan dibuang,
 *        bukan ditempelkan ke item lain.
 * @returns {Record<number, Array>}
 */
export function groupSmartlinkWork(details, rows, nameOf = () => null, allDetailIds = null) {
  const byDetail = {};
  const list = details || [];
  if (!list.length || !rows?.length) return byDetail;
  const ids = new Set(list.map((d) => Number(d.id)));
  const partial = allDetailIds instanceof Set && allDetailIds.size > ids.size;

  for (const r of rows) {
    const meta = SMARTLINK_STAGES[r.stage] || { stage: String(r.stage || "").toLowerCase(), label: r.stage };
    const entry = {
      id: `sl-${r.id}`,
      source: "smartlink",
      stage: meta.stage,
      stage_label: meta.label,
      smartlink_stage: r.stage,
      status: r.status,
      employee_id: r.employee_id || null,
      employee_name: (r.employee_id && nameOf(Number(r.employee_id))) || r.worker_name || null,
      notes: r.notes || null,
      qty: r.qty != null ? Number(r.qty) : null,
      unit: r.unit || null,
      completed_at: r.worked_at,
      created_at: r.worked_at,
      photos: [],
    };

    let targets = [];
    const did = Number(r.transaction_detail_id);
    if (did && ids.has(did)) {
      targets = [did];
    } else if (did && partial && allDetailIds.has(did)) {
      continue; // milik item yang tidak ditampilkan
    } else {
      const svc = normName(r.service_name);
      const match = svc ? list.filter((d) => normName(d.service_name) === svc) : [];
      if (match.length) targets = match.map((d) => Number(d.id));
      else if (partial) continue; // tampilan sebagian: jangan menebak
      else if (list.length === 1) targets = [Number(list[0].id)];
      else {
        targets = list.map((d) => Number(d.id));
        entry.notes = [entry.notes, "Tercatat untuk seluruh nota"].filter(Boolean).join(" · ");
      }
    }
    for (const t of targets) (byDetail[t] ||= []).push(t === targets[0] ? entry : { ...entry, id: `${entry.id}-${t}` });
  }
  return byDetail;
}
