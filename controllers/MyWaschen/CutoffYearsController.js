import { safeMyWaschenQuery } from "../../db/pool.js";
import { currentCutoffPeriod } from "./cutoffHelpers.js";

/**
 * Kolom tanggal tiap tabel yang dipakai filter periode My Waschen.
 * Tahun cutoff = tahun dari (tanggal + 6 hari): 26 Des 2025 masuk periode Januari 2026.
 */
const SOURCES = [
  ["tr_transaction", "created_at"],
  ["tr_cashier_shift", "opened_at"],
  ["tr_petty_cash", "transaction_date"],
  ["tr_attendance", "work_date"],
  ["tr_overtime", "overtime_date"],
  ["tr_leave", "start_date"],
  ["tr_employee_day_off", "off_date"],
  ["tr_kasbon", "submission_date"],
  ["tr_membership", "created_at"],
  ["mst_customer", "created_at"],
];

const cutoffYear = (col) => `YEAR(DATE_ADD(${col}, INTERVAL 6 DAY))`;

/** GET /waschen/cutoff-years — rentang tahun cutoff yang punya data di database (terbaru dulu). */
export async function getCutoffYears(req, res) {
  try {
    const results = await Promise.all(
      SOURCES.map(([table, col]) =>
        safeMyWaschenQuery(
          `SELECT MIN(${cutoffYear(col)}) AS min_y, MAX(${cutoffYear(col)}) AS max_y FROM ${table} WHERE ${col} IS NOT NULL`
        ).then(([rows]) => rows[0] || {}).catch(() => ({}))
      )
    );
    const current = currentCutoffPeriod().year;
    const lows = results.map((r) => Number(r.min_y)).filter((y) => y > 1990);
    const highs = results.map((r) => Number(r.max_y)).filter((y) => y > 1990);
    const min = Math.min(...lows, current);
    const max = Math.max(...highs, current);

    const years = [];
    for (let y = max; y >= min; y -= 1) years.push(y);
    return res.json({ success: true, years });
  } catch (err) {
    console.error("getCutoffYears:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat tahun periode" });
  }
}
