import { safeMyWaschenQuery } from "../../../db/pool.js";
import {
  autoFillHorizonYm,
  currentBillingYm,
  effectiveCustomerTarget,
  fillSalesTargets,
  getEffectiveSalesTargetsForMonth,
  loadCustomerTargets,
  loadExplicitSalesTargets,
  ymMonth,
  ymYear,
  addMonths,
  toYm,
  SMARTLINK_OUTLET_BY_ID,
} from "../utils/targetWaschen.js";
import { getMonthlyAdjustedActual } from "../../salesDashboard/salesController.js";

/** Jumlah bulan di grafik aktual vs target */
const CHART_MONTHS = 12;

const pad2 = (n) => String(n).padStart(2, "0");
/** Hari ini (WIB) sebagai YYYY-MM-DD */
function todayWib() {
  const now = new Date();
  const wib = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
  return `${wib.getFullYear()}-${pad2(wib.getMonth() + 1)}-${pad2(wib.getDate())}`;
}
/** Tanggal mulai bulan tagihan (tgl 26 bulan sebelumnya) */
const periodStartDate = (ym) => {
  const prev = addMonths(ym, -1);
  return `${ymYear(prev)}-${pad2(ymMonth(prev))}-26`;
};

/**
 * Target Waschen (Master Outlet My Waschen).
 *   Sales    : mst_target_waschen           — per outlet per bulan
 *   Customer : mst_target_customer_waschen  — per tahun
 * Periode tanpa target otomatis mengikuti periode sebelumnya (lihat utils/targetWaschen.js).
 */

const isValidMonth = (b) => Number.isInteger(Number(b)) && Number(b) >= 1 && Number(b) <= 12;
const isValidYear = (y) => Number.isInteger(Number(y)) && Number(y) >= 2000 && Number(y) <= 2100;
const isValidAmount = (n) => n !== "" && n !== null && n !== undefined && Number.isFinite(Number(n)) && Number(n) >= 0;

/* ══════════════════════ TARGET SALES ══════════════════════ */

/** GET /waschen/targets/sales?tahun=&bulan= → target efektif semua outlet untuk satu bulan */
export const getSalesTargetsForMonth = async (req, res) => {
  try {
    const billing = currentBillingYm();
    const tahun = Number(req.query.tahun) || ymYear(billing);
    const bulan = Number(req.query.bulan) || ymMonth(billing);
    if (!isValidMonth(bulan) || !isValidYear(tahun)) return res.status(400).json({ success: false, message: "Periode tidak valid" });
    const rows = await getEffectiveSalesTargetsForMonth(tahun, bulan);
    res.json({ success: true, data: rows, meta: { tahun, bulan, billing_tahun: ymYear(billing), billing_bulan: ymMonth(billing) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/targets/sales/outlet/:outletId → riwayat target satu outlet (terbaru dulu) */
export const getOutletSalesTargetHistory = async (req, res) => {
  try {
    const outletId = Number(req.params.outletId);
    const [[outlet]] = await safeMyWaschenQuery("SELECT id, outlet_code, name, full_name FROM mst_outlet WHERE id = ? LIMIT 1", [outletId]);
    if (!outlet) return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    const horizon = autoFillHorizonYm();
    const history = fillSalesTargets(await loadExplicitSalesTargets({ outletId }), horizon).reverse();

    // Grafik aktual vs target: 12 bulan tagihan terakhir s/d bulan berjalan.
    // Aktual = rumus halaman Sales (reguler + e-money − 70% Cleanox), dari Smartlink.
    const billingYm = currentBillingYm();
    const firstYm = addMonths(billingYm, -(CHART_MONTHS - 1));
    const smartlinkName = SMARTLINK_OUTLET_BY_ID[outletId] || null;
    let actualByYm = new Map();
    let actualError = null;
    if (smartlinkName) {
      try {
        const rows = await getMonthlyAdjustedActual(smartlinkName, periodStartDate(firstYm), todayWib());
        actualByYm = new Map(rows.map((r) => [r.ym, r]));
      } catch (e) {
        actualError = e.message;
      }
    }
    const targetByYm = new Map(history.map((r) => [toYm(r.tahun, r.bulan), r]));
    const chart = [];
    for (let ym = firstYm; ym <= billingYm; ym = addMonths(ym, 1)) {
      const t = targetByYm.get(ym);
      const a = actualByYm.get(ym);
      chart.push({
        tahun: ymYear(ym),
        bulan: ymMonth(ym),
        target: t ? t.nominal : null,
        target_is_auto: t ? t.is_auto : false,
        actual: smartlinkName ? (a ? a.actual : 0) : null,
        cleanox: a ? a.cleanox : 0,
        is_current: ym === billingYm,
      });
    }
    // Aktual juga ditempel ke riwayat (bulan di dalam rentang grafik)
    for (const r of history) {
      const a = actualByYm.get(toYm(r.tahun, r.bulan));
      if (a) r.actual = a.actual;
    }
    // Periode berikut yang disarankan untuk diisi: bulan setelah target TERSIMPAN terakhir
    const lastSaved = history.find((r) => !r.is_auto);
    const billing = currentBillingYm();
    const next = lastSaved ? addMonths(lastSaved.tahun * 100 + lastSaved.bulan, 1) : billing;
    res.json({
      success: true,
      data: {
        outlet,
        history,
        suggestion: { tahun: ymYear(next), bulan: ymMonth(next), nominal: lastSaved?.nominal ?? null },
        chart,
        chart_meta: {
          has_actual: Boolean(smartlinkName),
          actual_note: smartlinkName
            ? "Aktual = pembayaran reguler + e-money − 70% omzet Cleanox (sama dengan halaman Sales)"
            : "Outlet ini belum punya data penjualan di Smartlink",
          actual_error: actualError,
          as_of: todayWib(),
        },
        billing: { tahun: ymYear(billing), bulan: ymMonth(billing) },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /waschen/targets/sales { outlet_id, tahun, bulan, nominal }
 * Simpan target satu bulan. Bila bulan itu sudah ada (mis. menimpa nilai otomatis atau koreksi), nilainya diperbarui.
 */
export const saveSalesTarget = async (req, res) => {
  const { outlet_id, tahun, bulan, nominal } = req.body || {};
  if (!outlet_id || !isValidYear(tahun) || !isValidMonth(bulan) || !isValidAmount(nominal)) {
    return res.status(400).json({ success: false, message: "Outlet, tahun, bulan, dan nominal wajib diisi dengan benar" });
  }
  try {
    const [o] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ? LIMIT 1", [Number(outlet_id)]);
    if (!o.length) return res.status(400).json({ success: false, message: "Outlet tidak ditemukan" });
    const [r] = await safeMyWaschenQuery(
      `INSERT INTO mst_target_waschen (outlet_id, tahun, bulan, nominal) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nominal = VALUES(nominal)`,
      [Number(outlet_id), Number(tahun), Number(bulan), Math.round(Number(nominal))]
    );
    res.json({ success: true, message: r.affectedRows === 1 ? "Target sales disimpan" : "Target sales diperbarui" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** DELETE /waschen/targets/sales/:id → bulan itu kembali mengikuti target bulan sebelumnya */
export const deleteSalesTarget = async (req, res) => {
  try {
    const [r] = await safeMyWaschenQuery("DELETE FROM mst_target_waschen WHERE id = ?", [Number(req.params.id)]);
    if (!r.affectedRows) return res.status(404).json({ success: false, message: "Target tidak ditemukan" });
    res.json({ success: true, message: "Target dihapus. Bulan itu kembali mengikuti target bulan sebelumnya." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/* ══════════════════════ TARGET CUSTOMER ══════════════════════ */

/** GET /waschen/targets/customer → daftar per tahun + tahun berjalan (otomatis bila belum diisi) */
export const getCustomerTargets = async (req, res) => {
  try {
    const rows = await loadCustomerTargets();
    const year = new Date().getFullYear();
    const list = rows.map((r) => ({ ...r, is_auto: false }));
    // Tahun berjalan & depan yang belum diisi ditampilkan sebagai otomatis
    for (const y of [year + 1, year]) {
      if (!rows.some((r) => r.tahun === y)) {
        const auto = effectiveCustomerTarget(rows, y);
        if (auto) list.push(auto);
      }
    }
    list.sort((a, b) => b.tahun - a.tahun);
    res.json({ success: true, data: list, meta: { tahun_berjalan: year, current: effectiveCustomerTarget(rows, year) } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/targets/customer { tahun, jumlah } — simpan / perbarui target satu tahun */
export const saveCustomerTarget = async (req, res) => {
  const { tahun, jumlah } = req.body || {};
  if (!isValidYear(tahun) || !isValidAmount(jumlah)) return res.status(400).json({ success: false, message: "Tahun dan jumlah wajib diisi dengan benar" });
  try {
    const [r] = await safeMyWaschenQuery(
      `INSERT INTO mst_target_customer_waschen (tahun, jumlah) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE jumlah = VALUES(jumlah)`,
      [Number(tahun), Math.round(Number(jumlah))]
    );
    res.json({ success: true, message: r.affectedRows === 1 ? "Target customer disimpan" : "Target customer diperbarui" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/** DELETE /waschen/targets/customer/:id */
export const deleteCustomerTarget = async (req, res) => {
  try {
    const [r] = await safeMyWaschenQuery("DELETE FROM mst_target_customer_waschen WHERE id = ?", [Number(req.params.id)]);
    if (!r.affectedRows) return res.status(404).json({ success: false, message: "Target tidak ditemukan" });
    res.json({ success: true, message: "Target customer dihapus" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
