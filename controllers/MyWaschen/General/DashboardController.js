import { safeMyWaschenQuery } from "../../../db/pool.js";

function defaultDateRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

/** Filter nota berdasarkan tanggal order (operasional). */
function buildOrderFilters({ outletId, dateFrom, dateTo, alias = "t" }) {
  const where = ["1=1"];
  const params = [];

  if (outletId) {
    where.push(`${alias}.outlet_id = ?`);
    params.push(Number(outletId));
  }
  if (dateFrom) {
    where.push(`${alias}.order_date >= ?`);
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push(`${alias}.order_date <= ?`);
    params.push(`${dateTo} 23:59:59`);
  }

  return { whereSql: where.join(" AND "), params };
}

/**
 * Filter revenue: payment_status <> Outstanding, tanggal berdasarkan paid_at.
 * Contoh: nota tgl 1 Outstanding → bayar tgl 5 → revenue masuk tanggal 5.
 */
function buildRevenueFilters({ outletId, dateFrom, dateTo, alias = "t" }) {
  const where = [`${alias}.payment_status <> 'Outstanding'`, `${alias}.paid_at IS NOT NULL`];
  const params = [];

  if (outletId) {
    where.push(`${alias}.outlet_id = ?`);
    params.push(Number(outletId));
  }
  if (dateFrom) {
    where.push(`${alias}.paid_at >= ?`);
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push(`${alias}.paid_at <= ?`);
    params.push(`${dateTo} 23:59:59`);
  }

  return { whereSql: where.join(" AND "), params };
}

/** Nominal revenue: uang yang sudah dibayar (fallback grand_total jika paid_amount kosong). */
const REVENUE_AMOUNT = (alias = "t") =>
  `COALESCE(NULLIF(${alias}.paid_amount, 0), ${alias}.grand_total)`;

export const getDashboard = async (req, res) => {
  try {
    const defaults = defaultDateRange();
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const dateFrom = String(req.query.dateFrom || defaults.dateFrom).trim();
    const dateTo = String(req.query.dateTo || defaults.dateTo).trim();

    const orderF = buildOrderFilters({ outletId, dateFrom, dateTo });
    const revF = buildRevenueFilters({ outletId, dateFrom, dateTo });
    const revAmt = REVENUE_AMOUNT("t");

    const [
      [orderSummaryRows],
      [revenueSummaryRows],
      [salesTrend],
      [revenueByOutlet],
      [revenueByCategory],
      [revenueByService],
      [paymentStatus],
      [paymentMethod],
      [orderCategory],
      [workStatus],
      [recentTransactions],
      [customerSummaryRows],
      [customerByTier],
      [customerBySource],
      [membershipSummary],
      [topCustomers],
      [depositLedger],
    ] = await Promise.all([
      safeMyWaschenQuery(
        `SELECT
           COUNT(*) AS total_orders,
           COUNT(DISTINCT t.customer_id) AS active_customers,
           COALESCE(SUM(t.discount_amount), 0) AS total_discount,
           COALESCE(SUM(t.speed_surcharge), 0) AS total_speed_surcharge,
           COALESCE(SUM(CASE WHEN t.payment_status = 'Outstanding'
             THEN GREATEST(t.grand_total - t.paid_amount, 0) ELSE 0 END), 0) AS outstanding_amount
         FROM tr_transaction t
         WHERE ${orderF.whereSql}`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT
           COUNT(*) AS revenue_orders,
           COALESCE(SUM(${revAmt}), 0) AS total_revenue,
           COALESCE(AVG(${revAmt}), 0) AS avg_order_value,
           COALESCE(SUM(${revAmt}), 0) AS total_paid
         FROM tr_transaction t
         WHERE ${revF.whereSql}`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT DATE(t.paid_at) AS sale_date,
                COALESCE(SUM(${revAmt}), 0) AS revenue,
                COUNT(*) AS order_count
         FROM tr_transaction t
         WHERE ${revF.whereSql}
         GROUP BY DATE(t.paid_at)
         ORDER BY sale_date ASC`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT o.id AS outlet_id, o.outlet_code, o.name AS outlet_name,
                COALESCE(SUM(${revAmt}), 0) AS revenue,
                COUNT(*) AS order_count
         FROM tr_transaction t
         JOIN mst_outlet o ON o.id = t.outlet_id
         WHERE ${revF.whereSql}
         GROUP BY o.id, o.outlet_code, o.name
         ORDER BY revenue DESC`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT COALESCE(sc.name, 'Lainnya') AS category_name,
                COALESCE(sc.code, 'OTHER') AS category_code,
                COALESCE(SUM(td.subtotal), 0) AS revenue,
                COALESCE(SUM(td.qty), 0) AS qty
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         JOIN mst_service s ON s.id = td.service_id
         LEFT JOIN mst_service_category sc ON sc.id = s.category_id
         WHERE ${revF.whereSql}
         GROUP BY sc.id, sc.name, sc.code
         ORDER BY revenue DESC`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT s.id AS service_id, s.code AS service_code, s.name AS service_name,
                COALESCE(sc.name, 'Lainnya') AS category_name,
                COALESCE(SUM(td.subtotal), 0) AS revenue,
                COALESCE(SUM(td.qty), 0) AS qty
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         JOIN mst_service s ON s.id = td.service_id
         LEFT JOIN mst_service_category sc ON sc.id = s.category_id
         WHERE ${revF.whereSql}
         GROUP BY s.id, s.code, s.name, sc.name
         ORDER BY revenue DESC
         LIMIT 10`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT t.payment_status,
                COUNT(*) AS order_count,
                COALESCE(SUM(t.grand_total), 0) AS amount
         FROM tr_transaction t
         WHERE ${orderF.whereSql}
         GROUP BY t.payment_status
         ORDER BY amount DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT COALESCE(t.payment_method, 'Belum diisi') AS payment_method,
                COUNT(*) AS order_count,
                COALESCE(SUM(${revAmt}), 0) AS amount
         FROM tr_transaction t
         WHERE ${revF.whereSql}
         GROUP BY t.payment_method
         ORDER BY amount DESC`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT t.order_category,
                COUNT(*) AS order_count,
                COALESCE(SUM(${revAmt}), 0) AS revenue
         FROM tr_transaction t
         WHERE ${revF.whereSql}
         GROUP BY t.order_category
         ORDER BY revenue DESC`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT td.item_work_status AS status,
                COUNT(*) AS item_count,
                COALESCE(SUM(td.subtotal), 0) AS revenue
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         WHERE ${orderF.whereSql}
         GROUP BY td.item_work_status
         ORDER BY item_count DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT t.id, t.order_no, t.order_date, t.paid_at, t.order_category, t.grand_total,
                t.payment_status, t.payment_method, t.work_status, t.paid_amount,
                c.name AS customer_name, c.customer_code,
                o.name AS outlet_name, o.outlet_code,
                ss.name AS speed_name,
                pf.name AS parfume_name,
                (SELECT COUNT(*) FROM tr_transaction_detail td WHERE td.transaction_id = t.id) AS item_count
         FROM tr_transaction t
         LEFT JOIN mst_customer c ON c.id = t.customer_id
         LEFT JOIN mst_outlet o ON o.id = t.outlet_id
         LEFT JOIN mst_service_speed ss ON ss.id = t.speed_id
         LEFT JOIN mst_parfume pf ON pf.id = t.parfume_id
         WHERE ${orderF.whereSql}
         ORDER BY t.order_date DESC
         LIMIT 12`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT
           COUNT(*) AS total_customers,
           SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_customers,
           COALESCE(SUM(deposit_balance), 0) AS total_deposit_balance,
           COALESCE(SUM(total_spent), 0) AS lifetime_spent,
           COALESCE(SUM(monthly_spending), 0) AS monthly_spending_total,
           SUM(CASE WHEN active_membership_id IS NOT NULL THEN 1 ELSE 0 END) AS customers_with_membership
         FROM mst_customer`
      ),
      safeMyWaschenQuery(
        `SELECT COALESCE(ct.name, 'Belum ada tier') AS tier_name,
                COALESCE(ct.code, 'NONE') AS tier_code,
                COUNT(c.id) AS customer_count,
                COALESCE(SUM(c.total_spent), 0) AS total_spent,
                COALESCE(SUM(c.deposit_balance), 0) AS deposit_balance
         FROM mst_customer c
         LEFT JOIN mst_customer_tier ct ON ct.id = c.spending_tier_id
         WHERE c.is_active = 1
         GROUP BY ct.id, ct.name, ct.code
         ORDER BY customer_count DESC`
      ),
      safeMyWaschenQuery(
        `SELECT COALESCE(cs.label, cs.name, 'Tidak diketahui') AS source_label,
                COUNT(c.id) AS customer_count
         FROM mst_customer c
         LEFT JOIN mst_customer_source cs ON cs.id = c.customer_source_id
         WHERE c.is_active = 1
         GROUP BY cs.id, cs.label, cs.name
         ORDER BY customer_count DESC
         LIMIT 8`
      ),
      safeMyWaschenQuery(
        `SELECT mp.tier, mp.name AS package_name,
                COUNT(tm.id) AS active_memberships,
                COALESCE(SUM(tm.top_up_amount), 0) AS total_top_up
         FROM tr_membership tm
         JOIN mst_membership_package mp ON mp.id = tm.package_id
         WHERE tm.status = 'Active'
         GROUP BY mp.id, mp.tier, mp.name
         ORDER BY active_memberships DESC`
      ),
      safeMyWaschenQuery(
        `SELECT c.id, c.customer_code, c.name, c.phone,
                COALESCE(c.total_spent, 0) AS total_spent,
                COALESCE(c.total_orders, 0) AS total_orders,
                COALESCE(c.deposit_balance, 0) AS deposit_balance,
                COALESCE(ct.name, '—') AS tier_name,
                COALESCE(o.name, c.home_branch, '—') AS outlet_name,
                mp.name AS membership_package
         FROM mst_customer c
         LEFT JOIN mst_customer_tier ct ON ct.id = c.spending_tier_id
         LEFT JOIN mst_outlet o ON o.id = c.preferred_outlet_id
         LEFT JOIN tr_membership tm ON tm.id = c.active_membership_id
         LEFT JOIN mst_membership_package mp ON mp.id = tm.package_id
         WHERE c.is_active = 1
         ORDER BY c.total_spent DESC
         LIMIT 8`
      ),
      safeMyWaschenQuery(
        `SELECT d.type,
                COUNT(*) AS txn_count,
                COALESCE(SUM(d.amount), 0) AS total_amount
         FROM tr_customer_deposit d
         WHERE d.created_at >= ? AND d.created_at <= ?
         GROUP BY d.type
         ORDER BY total_amount DESC`,
        [`${dateFrom} 00:00:00`, `${dateTo} 23:59:59`]
      ),
    ]);

    res.json({
      success: true,
      data: {
        filters: { outletId, dateFrom, dateTo },
        summary: {
          ...(orderSummaryRows[0] || {}),
          ...(revenueSummaryRows[0] || {}),
          ...(customerSummaryRows[0] || {}),
        },
        salesTrend,
        revenueByOutlet,
        revenueByCategory,
        revenueByService,
        paymentStatus,
        paymentMethod,
        orderCategory,
        workStatus,
        recentTransactions,
        customerByTier,
        customerBySource,
        membershipSummary,
        topCustomers,
        depositLedger,
      },
    });
  } catch (err) {
    console.error("getDashboard error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
