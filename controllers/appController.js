import { safeQuery, safeMyWaschenQuery } from "../db/pool.js";
import { effectiveCustomerTarget, getEffectiveSalesTargetsForMonth, loadCustomerTargets } from "./MyWaschen/utils/targetWaschen.js";
import { REVENUE_PAYMENTS_SQL, revenuePaymentParams, WASCHEN_SHARE } from "./MyWaschen/utils/revenue.js";

// ═══════════════════════════════════════════════════════════════════════════
// Employee Stats — data real dari mst_employee
// ═══════════════════════════════════════════════════════════════════════════
export const getEmployeeStats = async (req, res) => {
  try {
    const [rows] = await safeQuery(`
      SELECT
        SUM(CASE WHEN company_id = 1 AND exit_date IS NULL THEN 1 ELSE 0 END) AS alora,
        SUM(CASE WHEN company_id = 2 AND exit_date IS NULL THEN 1 ELSE 0 END) AS ikm,
        SUM(CASE WHEN company_id = 3 AND exit_date IS NULL THEN 1 ELSE 0 END) AS cleanox,
        SUM(CASE WHEN company_id = 5 AND exit_date IS NULL THEN 1 ELSE 0 END) AS waschen,
        SUM(CASE WHEN company_id IN (1,2,3,5) AND exit_date IS NULL THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN join_date IS NOT NULL AND MONTH(join_date) = MONTH(CURDATE()) AND YEAR(join_date) = YEAR(CURDATE()) THEN 1 ELSE 0 END) AS new_this_month
      FROM mst_employee
      WHERE is_deleted = 0
    `);

    const data = rows[0] || {};
    res.json({
      success: true,
      data: {
        total:          Number(data.total   || 0),
        alora:          Number(data.alora   || 0),
        ikm:            Number(data.ikm     || 0),
        cleanox:        Number(data.cleanox || 0),
        waschen:        Number(data.waschen || 0),
        new_this_month: Number(data.new_this_month || 0),
      },
    });
  } catch (err) {
    console.error("[getEmployeeStats] Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// Peta path → role yang diizinkan, dipakai <ProtectedRoute> di frontend.
export const getAppAuthorization = async (req, res) => {
  try {
    const [apps] = await safeQuery(
      `SELECT href AS path, authorization
         FROM mst_apps
        WHERE is_active = 1
        ORDER BY sort_order ASC`
    );
    res.json(apps);
  } catch (err) {
    console.error("[getAppAuthorization] Error:", err);
    res.status(500).json({ message: "Gagal memuat otorisasi aplikasi" });
  }
};

export const getApps = async (req, res) => {

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized: not logged in" });
  }

  const [userRows] = await safeQuery(
    "SELECT role FROM users WHERE id = ?",
    [userId]
  );
  if (userRows.length === 0) {
    return res.status(401).json({ message: "User not found" });
  }

  const myRole = userRows[0].role;

  const [apps] = await safeQuery(
    `SELECT id, name, description, href, authorization, is_active 
     FROM mst_apps 
     WHERE is_active = 1 
     ORDER BY sort_order ASC`
  );

  const filteredApps = apps.filter(app => {
    if (!app.authorization) return false;
    const allowedRoles = app.authorization.split(",").map(r => r.trim());
    return allowedRoles.includes(myRole);
  });

  res.json({ apps: filteredApps, role: myRole });
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Get Sales Stats dari Smartlink DB
// ═══════════════════════════════════════════════════════════════════════════
/** Tanggal lokal (WIB, timezone pool) → 'YYYY-MM-DD'. */
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Periode cutoff berjalan (26 → 25) berdasarkan hari ini; bulan target = bulan tanggal akhir. */
function currentCutoff(now = new Date()) {
  const endMonth = now.getDate() > 25
    ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(endMonth.getFullYear(), endMonth.getMonth() - 1, 26);
  const end = new Date(endMonth.getFullYear(), endMonth.getMonth(), 25);
  return { start, end, tahun: endMonth.getFullYear(), bulan: endMonth.getMonth() + 1 };
}

const dayDiff = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);

/**
 * Kartu "Total Sales" Portal — data myWaschen (bukan lagi waschen_smartlink).
 * Sales = revenue Waschen (pembayaran DP/Lunas/Pelunasan, nota Cleanox 30%), definisi yang sama
 * dengan Dashboard Waschen. Periode cutoff berjalan sampai sekarang (POS real-time).
 * Target = mst_target_waschen per outlet (otomatis ikut bulan sebelumnya bila kosong).
 */
export const getSalesStats = async (req, res) => {
  try {
    const now = new Date();
    const { start, end, tahun, bulan } = currentCutoff(now);
    const targets = await getEffectiveSalesTargetsForMonth(tahun, bulan);

    const from = `${ymd(start)} 00:00:00`;
    const to = `${ymd(now)} 23:59:59`;
    const [actualRows] = await safeMyWaschenQuery(
      `SELECT t.outlet_id, SUM(rp.amount * ${WASCHEN_SHARE("t")}) AS actual_sales
       FROM (${REVENUE_PAYMENTS_SQL}) rp
       JOIN tr_transaction t ON t.id = rp.transaction_id
       WHERE t.is_delete_requested = 0
       GROUP BY t.outlet_id`,
      revenuePaymentParams(from, to)
    );
    const actualByOutlet = new Map(actualRows.map((r) => [Number(r.outlet_id), Number(r.actual_sales) || 0]));

    // Hari berjalan / total hari periode → target kumulatif s.d. hari ini
    const totalDay = dayDiff(start, end) + 1;
    const dateCount = Math.min(totalDay, Math.max(0, dayDiff(start, now) + 1));
    const ratio = totalDay > 0 ? dateCount / totalDay : 0;

    const detail = targets.map((t) => {
      const target = Number(t.nominal) || 0;
      const actual = actualByOutlet.get(Number(t.outlet_id)) || 0;
      const persenActual = target > 0 ? (actual / target) * 100 : 0;
      return {
        outlet_id: t.outlet_id,
        target_bulanan: target,
        actual_sales: Math.round(actual),
        target_kumulatif_sales: Math.round(ratio * target),
        gap_nominal: Math.round(actual - ratio * target),
        persen_actual: Number(persenActual.toFixed(2)),
        persen_gap: Number((persenActual - ratio * 100).toFixed(2)),
      };
    });

    // Total = semua outlet (termasuk outlet tanpa target, mis. drop point / event)
    const totalActual = Math.round([...actualByOutlet.values()].reduce((a, b) => a + b, 0));
    const totalTarget = detail.reduce((sum, r) => sum + r.target_bulanan, 0);
    const percentage = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;
    const salesGrowth = totalTarget > 0 ? ((totalActual / totalTarget) - ratio) * 100 : 0;

    res.json({
      success: true,
      data: {
        actual_sales: totalActual,
        target_bulanan: totalTarget,
        percentage,
        sales_growth: Number(salesGrowth.toFixed(2)),
        period_start: ymd(start),
        period_end: ymd(end),
        detail_per_outlet: detail,
      },
    });
  } catch (error) {
    console.error("[getSalesStats] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data sales",
    });
  }
};

/**
 * Kartu "Total Customer Baru" Portal — data myWaschen (bukan lagi waschen_smartlink).
 * Aktif = basis tahun lalu (mst_target_customer_waschen) + pelanggan yang terdaftar sejak 26 Jan
 * tahun ini (mst_customer.created_at, tanggal daftar asli hasil migrasi Smartlink) DAN punya nota
 * di periode itu. Pengecualian sama dengan query lama: nama haji/tni/dumm/tes, item haji.
 */
export const getCustomerTargets = async (req, res) => {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const obsStart = `${currentYear}-01-26`;
    const obsEnd = ymd(now);

    // Target customer dari myWaschen.mst_target_customer_waschen.
    // Tahun berjalan yang belum diisi otomatis mengikuti target tahun sebelumnya.
    const customerTargets = await loadCustomerTargets();
    const targetCustomer = effectiveCustomerTarget(customerTargets, currentYear)?.jumlah ?? 0;
    // Tahun lalu = nilai tersimpan saja (dipakai sebagai basis customer yang sudah ada)
    const existingCustomer = customerTargets.find((r) => r.tahun === currentYear - 1)?.jumlah ?? 0;

    const [[row]] = await safeMyWaschenQuery(
      `SELECT COUNT(*) AS new_customer_transaksi
       FROM mst_customer c
       WHERE c.created_at >= ? AND c.created_at <= ?
         AND c.name NOT LIKE '%haji%' AND c.name NOT LIKE '%tni%'
         AND c.name NOT LIKE '%dumm%' AND c.name NOT LIKE '%tes%'
         AND EXISTS (
           SELECT 1
           FROM tr_transaction t
           JOIN tr_transaction_detail d ON d.transaction_id = t.id
           WHERE t.customer_id = c.id
             AND t.is_delete_requested = 0
             AND t.order_date >= ? AND t.order_date <= ?
             AND COALESCE(d.service_name, '') NOT LIKE '%haji%'
         )`,
      [`${obsStart} 00:00:00`, `${obsEnd} 23:59:59`, `${obsStart} 00:00:00`, `${obsEnd} 23:59:59`]
    );

    const newCustomerTransaksi = Number(row?.new_customer_transaksi) || 0;
    const actualCustomer = existingCustomer + newCustomerTransaksi;
    const percentage = targetCustomer > 0 ? Math.round((actualCustomer / targetCustomer) * 100) : 0;

    res.json({
      success: true,
      data: {
        actual_customer: actualCustomer,
        target_customer: targetCustomer,
        percentage,
        new_customer: newCustomerTransaksi,
        existing_customer: existingCustomer,
        obs_start: obsStart,
        obs_end: obsEnd,
        year: currentYear,
      },
    });
  } catch (error) {
    console.error("[getCustomerTargets] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data customer",
    });
  }
};
