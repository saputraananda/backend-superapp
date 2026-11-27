/**
 * Info member untuk nota (cetak & nota digital) — salinan sama di POS
 * (my-waschen-new/api/utils/memberNota.js).
 *
 * - Tipe Member  : paket membership customer (Member Gold / Member Diamond)
 * - Saldo Sebelum: saldo sebelum dipotong nota ini (mutasi Payment_Debit "Pembayaran nota <no>")
 * - Saldo Terakhir: saldo setelah mutasi terakhir nota ini (termasuk saldo dikembalikan bila pembayaran dibatalkan).
 *   Nota tanpa potong saldo → sebelum = terakhir = saldo customer saat ini.
 * - Masa Aktif   : tanggal berakhir membership.
 * Customer tanpa membership → null (blok member tidak dicetak).
 *
 * @param {(sql: string, params: any[]) => Promise<[any[]]>} query  mis. (s, p) => pool.query(s, p)
 */
export async function getMemberNotaInfo(query, orderKey) {
  const key = String(orderKey || '').trim();
  if (!key) return null;
  const [txRows] = await query(
    `SELECT t.id, t.order_no, t.customer_id, c.deposit_balance, c.active_membership_id
     FROM tr_transaction t
     JOIN mst_customer c ON c.id = t.customer_id
     WHERE t.order_no = ? OR t.id = ?
     LIMIT 1`,
    [key, /^\d+$/.test(key) ? Number(key) : -1]
  );
  const tx = txRows[0];
  if (!tx) return null;

  const [memRows] = await query(
    `SELECT m.id, m.status, DATE_FORMAT(m.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(m.end_date, '%Y-%m-%d') AS end_date, p.name AS package_name, p.tier
     FROM tr_membership m
     LEFT JOIN mst_membership_package p ON p.id = m.package_id
     WHERE m.customer_id = ? AND m.status <> 'Cancelled'
     ORDER BY (m.id = ?) DESC, m.end_date DESC, m.id DESC
     LIMIT 1`,
    [tx.customer_id, tx.active_membership_id || 0]
  );
  const mem = memRows[0];

  const [mut] = await query(
    `SELECT type, amount, balance_before, balance_after
     FROM tr_customer_deposit
     WHERE customer_id = ?
       AND ((type = 'Payment_Debit' AND (notes = ? OR notes LIKE ?)) OR order_id = ?)
     ORDER BY id ASC`,
    // Sinkron Smartlink menulis "Pembayaran nota <no> (Smartlink) [SL-DELTA ...]"
    [tx.customer_id, `Pembayaran nota ${tx.order_no}`, `Pembayaran nota ${tx.order_no} %`, tx.id]
  );
  const current = Number(tx.deposit_balance) || 0;
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10); // WIB
  const expiresAt = mem?.end_date || null;
  const base = {
    tier: mem?.package_name || (mem?.tier ? `Member ${mem.tier}` : 'Member'),
    expiresAt,
    isExpired: Boolean(expiresAt && expiresAt < today) || mem?.status === 'Expired',
  };

  if (mut.length) {
    const debited = mut.filter((r) => r.type === 'Payment_Debit').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const returned = mut.filter((r) => r.type === 'Refund').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      ...base,
      balanceBefore: Number(mut[0].balance_before) || 0,
      balanceAfter: Number(mut[mut.length - 1].balance_after) || 0,
      deducted: Math.max(0, debited - returned),
    };
  }

  // Nota lama (Smartlink) dibayar potong saldo: tidak ada mutasi per nota, saldo Smartlink
  // hanya diakui sebagai angka akhir. Saldo dihitung mundur dari mutasi saldo terdekat
  // SETELAH pembayaran (saldo sebelum mutasi itu) + potong saldo nota lain di antaranya.
  const [pays] = await query(
    `SELECT id, amount, created_at FROM tr_payment_log
     WHERE transaction_id = ? AND log_type IN (${SALDO_LOG_TYPES}) AND amount > 0 AND ${SALDO_METHOD_SQL('payment_method')}
     ORDER BY created_at ASC, id ASC`,
    [tx.id]
  );
  if (pays.length) {
    const last = pays[pays.length - 1];
    const [anchorRows] = await query(
      `SELECT balance_before, created_at FROM tr_customer_deposit
       WHERE customer_id = ? AND created_at > ?
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [tx.customer_id, last.created_at]
    );
    const anchor = anchorRows[0];
    const [laterRows] = await query(
      `SELECT COALESCE(SUM(pl.amount), 0) AS total
       FROM tr_payment_log pl
       JOIN tr_transaction t2 ON t2.id = pl.transaction_id
       WHERE t2.customer_id = ? AND pl.transaction_id <> ?
         AND pl.log_type IN (${SALDO_LOG_TYPES}) AND pl.amount > 0 AND ${SALDO_METHOD_SQL('pl.payment_method')}
         AND (pl.created_at > ? OR (pl.created_at = ? AND pl.id > ?))
         ${anchor ? 'AND pl.created_at < ?' : ''}`,
      [tx.customer_id, tx.id, last.created_at, last.created_at, last.id, ...(anchor ? [anchor.created_at] : [])]
    );
    const paidHere = pays.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const after = (anchor ? Number(anchor.balance_before) || 0 : current) + (Number(laterRows[0]?.total) || 0);
    return { ...base, balanceBefore: after + paidHere, balanceAfter: after, deducted: paidHere };
  }

  if (!mem) return null;
  // Member yang bayar dengan metode lain: saldo tidak berubah
  return { ...base, balanceBefore: current, balanceAfter: current, deducted: 0 };
}

const SALDO_LOG_TYPES = "'DP','Lunas','Pelunasan'";
const SALDO_METHOD_SQL = (col) => `LOWER(COALESCE(${col}, '')) LIKE '%saldo%'`;
