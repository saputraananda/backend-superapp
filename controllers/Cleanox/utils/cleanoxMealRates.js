import { safeCleanoxQuery } from "../../../db/pool.js";

export const MEAL_RATE_DEFAULTS = { office: 10000, half_day: 25000, full_day: 30000 };

const RATE_LABELS = { office: "Kantor", half_day: "Half Day", full_day: "Full Day" };
const RATE_CODES = Object.keys(MEAL_RATE_DEFAULTS);

async function fetchRateRows() {
  try {
    const [rows] = await safeCleanoxQuery(
      `SELECT code, label, amount, updated_by_name, updated_at FROM mst_worker_meal_rate`
    );
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * Tarif uang makan aktif, fallback ke default per code.
 * @returns {Promise<{office: number, half_day: number, full_day: number}>}
 */
export async function getCleanoxMealRates() {
  const rows = await fetchRateRows();
  const rates = { ...MEAL_RATE_DEFAULTS };
  for (const row of rows) {
    const code = String(row.code || "");
    const amount = Number(row.amount);
    if (RATE_CODES.includes(code) && Number.isFinite(amount)) {
      rates[code] = amount;
    }
  }
  return rates;
}

/**
 * Baris tarif lengkap untuk halaman pengaturan.
 */
export async function listCleanoxMealRateRows() {
  const rows = await fetchRateRows();
  const byCode = new Map(rows.map((r) => [String(r.code), r]));
  return RATE_CODES.map((code) => {
    const row = byCode.get(code);
    return {
      code,
      label: row?.label || RATE_LABELS[code],
      amount: row ? Number(row.amount) : MEAL_RATE_DEFAULTS[code],
      updated_by_name: row?.updated_by_name || null,
      updated_at: row?.updated_at || null,
    };
  });
}
