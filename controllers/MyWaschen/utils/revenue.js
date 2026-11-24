import { safeMyWaschenQuery } from "../../../db/pool.js";

/**
 * DEFINISI REVENUE (seragam POS & SuperApp, keputusan user 2026-11-24) — sama dengan
 * my-waschen-new/api/utils/revenue.js:
 *   Revenue = uang yang MASUK dari pembayaran nota, diakui pada jam pembayaran.
 *   - Sumber: tr_payment_log log_type DP / Lunas / Pelunasan (DP ikut dihitung saat dibayar).
 *   - Nota outstanding (belum ada pembayaran) BUKAN revenue.
 *   - Revenue Tunai = metode Tunai/Cash; Revenue Non Tunai = lainnya (termasuk Potong Saldo Member).
 *   - Nota lama tanpa log pembayaran (migrasi Smartlink) = satu pembayaran pada paid_at
 *     sebesar paid_amount (fallback grand_total). Top-up saldo member bukan revenue.
 */
export const REVENUE_LOG_TYPES = "('DP','Lunas','Pelunasan')";

export const isTunaiMethod = (method) => /tunai|cash/i.test(String(method || ""));

/** Ekspresi SQL: 1 bila kolom metode termasuk tunai. */
export const TUNAI_SQL = (col) => `(LOWER(COALESCE(${col}, '')) REGEXP 'tunai|cash')`;

/**
 * Subquery baris pembayaran revenue di rentang [from, to]:
 * kolom transaction_id, amount, method, paid_at. Params: revenuePaymentParams(from, to).
 */
export const REVENUE_PAYMENTS_SQL = `
  SELECT pl.transaction_id, pl.amount, pl.payment_method AS method, pl.created_at AS paid_at
  FROM tr_payment_log pl
  WHERE pl.log_type IN ${REVENUE_LOG_TYPES} AND pl.amount > 0
    AND pl.created_at >= ? AND pl.created_at <= ?
  UNION ALL
  SELECT t0.id, COALESCE(NULLIF(t0.paid_amount, 0), t0.grand_total), t0.payment_method, t0.paid_at
  FROM tr_transaction t0
  WHERE t0.payment_status <> 'Outstanding' AND t0.paid_at IS NOT NULL
    AND t0.paid_at >= ? AND t0.paid_at <= ?
    AND NOT EXISTS (
      SELECT 1 FROM tr_payment_log p0
      WHERE p0.transaction_id = t0.id AND p0.log_type IN ${REVENUE_LOG_TYPES} AND p0.amount > 0
    )`;

export const revenuePaymentParams = (from, to) => [from, to, from, to];

/** Revenue shift: pembayaran outlet itu antara opened_at dan closed_at (atau sekarang). */
export async function getShiftRevenue(shift) {
  const until = shift.closed_at || "9999-12-31 23:59:59";
  const [rows] = await safeMyWaschenQuery(
    `SELECT rp.method, SUM(rp.amount) AS amount
     FROM (${REVENUE_PAYMENTS_SQL}) rp
     JOIN tr_transaction t ON t.id = rp.transaction_id
     WHERE t.outlet_id = ? AND t.is_delete_requested = 0
     GROUP BY rp.method`,
    [...revenuePaymentParams(shift.opened_at, until), shift.outlet_id]
  );
  let tunai = 0;
  let nonTunai = 0;
  for (const r of rows) {
    const amount = Number(r.amount) || 0;
    if (isTunaiMethod(r.method)) tunai += amount;
    else nonTunai += amount;
  }
  return { tunai, nonTunai, total: tunai + nonTunai };
}
