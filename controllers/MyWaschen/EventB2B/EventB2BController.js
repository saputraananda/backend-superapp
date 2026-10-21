import { safeMyWaschenQuery } from "../../../db/pool.js";

/**
 * Event B2B (mis. Event Haji): outlet virtual mst_outlet.is_event = 1.
 * Semua nota event ditandai tr_transaction.is_event = 1, item dikerjakan cabang
 * tr_transaction_detail.production_outlet_id (NULL = belum dibagi).
 */

/** Filter nota event: event tertentu (opsional) + rentang tanggal order (opsional). */
function buildEventFilters({ eventOutletId, dateFrom, dateTo, dateCol = "order_date", alias = "t" }) {
  const where = [`${alias}.is_event = 1`];
  const params = [];
  if (eventOutletId) {
    where.push(`${alias}.outlet_id = ?`);
    params.push(eventOutletId);
  }
  if (dateFrom) {
    where.push(`${alias}.${dateCol} >= ?`);
    params.push(`${dateFrom} 00:00:00`);
  }
  if (dateTo) {
    where.push(`${alias}.${dateCol} <= ?`);
    params.push(`${dateTo} 23:59:59`);
  }
  return { whereSql: where.join(" AND "), params };
}

function readFilters(query) {
  const eventOutletId = Number(query.eventOutletId) || null;
  const dateFrom = String(query.dateFrom || "").trim().slice(0, 10);
  const dateTo = String(query.dateTo || "").trim().slice(0, 10);
  return { eventOutletId, dateFrom, dateTo };
}

/** Nominal revenue: uang yang sudah dibayar (sama dengan Dashboard My Waschen). */
const REVENUE_AMOUNT = "COALESCE(NULLIF(t.paid_amount, 0), t.grand_total)";

/** GET /waschen/event/outlets — daftar outlet event, yang sedang berjalan dulu. */
export const getEventOutlets = async (_req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT id, outlet_code, name, full_name, COALESCE(event_active, 0) AS event_active
       FROM mst_outlet
       WHERE is_event = 1
       ORDER BY event_active DESC, id DESC`
    );
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, event_active: Number(r.event_active) === 1 })),
    });
  } catch (err) {
    console.error("getEventOutlets error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/event/dashboard?eventOutletId=&dateFrom=&dateTo= */
export const getEventDashboard = async (req, res) => {
  try {
    const filters = readFilters(req.query);
    const orderF = buildEventFilters(filters);
    const revF = buildEventFilters({ ...filters, dateCol: "paid_at" });
    const revWhere = `${revF.whereSql} AND t.payment_status <> 'Outstanding' AND t.paid_at IS NOT NULL`;

    const [
      [orderSummaryRows],
      [revenueSummaryRows],
      [itemSummaryRows],
      [salesTrend],
      [revenueByEvent],
      [productionByBranch],
      [workStatus],
      [paymentStatus],
      [revenueByService],
      [topCustomers],
      [recentTransactions],
    ] = await Promise.all([
      safeMyWaschenQuery(
        `SELECT COUNT(*) AS total_orders,
                COUNT(DISTINCT t.customer_id) AS total_customers,
                COALESCE(SUM(t.grand_total), 0) AS total_billed,
                COALESCE(SUM(CASE WHEN t.payment_status <> 'Lunas'
                  THEN GREATEST(t.grand_total - t.paid_amount, 0) ELSE 0 END), 0) AS outstanding_amount,
                SUM(CASE WHEN t.payment_status <> 'Lunas' THEN 1 ELSE 0 END) AS outstanding_orders
         FROM tr_transaction t
         WHERE ${orderF.whereSql}`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT COUNT(*) AS revenue_orders,
                COALESCE(SUM(${REVENUE_AMOUNT}), 0) AS total_revenue,
                COALESCE(AVG(${REVENUE_AMOUNT}), 0) AS avg_order_value
         FROM tr_transaction t
         WHERE ${revWhere}`,
        revF.params
      ),
      safeMyWaschenQuery(
        `SELECT COUNT(*) AS total_items,
                SUM(CASE WHEN td.production_outlet_id IS NULL THEN 1 ELSE 0 END) AS unassigned_items,
                SUM(CASE WHEN td.item_work_status IN ('Siap Diambil', 'Selesai') THEN 1 ELSE 0 END) AS done_items,
                SUM(CASE WHEN td.is_on_hold = 1 THEN 1 ELSE 0 END) AS hold_items
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         WHERE ${orderF.whereSql} AND td.is_production = 1 AND td.item_work_status <> 'Dibatalkan'`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT DATE(t.order_date) AS order_day,
                COUNT(*) AS order_count,
                COALESCE(SUM(t.grand_total), 0) AS billed
         FROM tr_transaction t
         WHERE ${orderF.whereSql}
         GROUP BY DATE(t.order_date)
         ORDER BY order_day ASC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT o.id AS outlet_id, o.outlet_code, o.name AS outlet_name,
                COUNT(*) AS order_count,
                COALESCE(SUM(t.grand_total), 0) AS billed,
                COALESCE(SUM(t.paid_amount), 0) AS paid
         FROM tr_transaction t
         JOIN mst_outlet o ON o.id = t.outlet_id
         WHERE ${orderF.whereSql}
         GROUP BY o.id, o.outlet_code, o.name
         ORDER BY billed DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT td.production_outlet_id AS outlet_id,
                COALESCE(po.outlet_code, '-') AS outlet_code,
                COALESCE(po.name, 'Belum dibagi') AS outlet_name,
                COUNT(*) AS total_items,
                SUM(CASE WHEN td.item_work_status IN ('Siap Diambil', 'Selesai') THEN 1 ELSE 0 END) AS done_items,
                COALESCE(SUM(td.qty), 0) AS total_qty
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         LEFT JOIN mst_outlet po ON po.id = td.production_outlet_id
         WHERE ${orderF.whereSql} AND td.is_production = 1 AND td.item_work_status <> 'Dibatalkan'
         GROUP BY td.production_outlet_id, po.outlet_code, po.name
         ORDER BY td.production_outlet_id IS NULL DESC, total_items DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT td.item_work_status AS status, COUNT(*) AS item_count
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         WHERE ${orderF.whereSql} AND td.is_production = 1
         GROUP BY td.item_work_status
         ORDER BY item_count DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT t.payment_status, COUNT(*) AS order_count,
                COALESCE(SUM(t.grand_total), 0) AS amount
         FROM tr_transaction t
         WHERE ${orderF.whereSql}
         GROUP BY t.payment_status
         ORDER BY amount DESC`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT td.service_id, MAX(td.service_name) AS service_name,
                COALESCE(SUM(td.qty), 0) AS qty,
                COALESCE(SUM(td.subtotal), 0) AS billed
         FROM tr_transaction_detail td
         JOIN tr_transaction t ON t.id = td.transaction_id
         WHERE ${orderF.whereSql} AND td.item_work_status <> 'Dibatalkan'
         GROUP BY td.service_id
         ORDER BY billed DESC
         LIMIT 10`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT c.id, c.customer_code, c.name, c.phone,
                COUNT(*) AS order_count,
                COALESCE(SUM(t.grand_total), 0) AS billed,
                COALESCE(SUM(GREATEST(t.grand_total - t.paid_amount, 0)), 0) AS outstanding
         FROM tr_transaction t
         JOIN mst_customer c ON c.id = t.customer_id
         WHERE ${orderF.whereSql}
         GROUP BY c.id, c.customer_code, c.name, c.phone
         ORDER BY billed DESC
         LIMIT 8`,
        orderF.params
      ),
      safeMyWaschenQuery(
        `SELECT t.id, t.order_no, t.order_date, t.grand_total, t.payment_status, t.work_status,
                c.name AS customer_name, o.outlet_code, o.name AS outlet_name,
                (SELECT COUNT(*) FROM tr_transaction_detail td
                  WHERE td.transaction_id = t.id AND td.is_production = 1) AS item_count
         FROM tr_transaction t
         LEFT JOIN mst_customer c ON c.id = t.customer_id
         LEFT JOIN mst_outlet o ON o.id = t.outlet_id
         WHERE ${orderF.whereSql}
         ORDER BY t.order_date DESC
         LIMIT 10`,
        orderF.params
      ),
    ]);

    res.json({
      success: true,
      data: {
        filters,
        summary: {
          ...(orderSummaryRows[0] || {}),
          ...(revenueSummaryRows[0] || {}),
          ...(itemSummaryRows[0] || {}),
        },
        salesTrend,
        revenueByEvent,
        productionByBranch,
        workStatus,
        paymentStatus,
        revenueByService,
        topCustomers,
        recentTransactions,
      },
    });
  } catch (err) {
    console.error("getEventDashboard error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

const CUSTOMER_SORTS = {
  customer_code: "c.customer_code",
  name: "c.name",
  phone: "c.phone",
  order_count: "order_count",
  billed: "billed",
  paid: "paid",
  outstanding: "outstanding",
  first_order_at: "first_order_at",
  last_order_at: "last_order_at",
};

/**
 * GET /waschen/event/customers?eventOutletId=&dateFrom=&dateTo=&search=&sortBy=&page=&limit=
 * Pelanggan yang pernah bertransaksi di outlet event, beserta ringkasan nota event-nya.
 */
export const getEventCustomers = async (req, res) => {
  try {
    const filters = readFilters(req.query);
    const f = buildEventFilters(filters);
    const where = [f.whereSql];
    const params = [...f.params];

    const search = String(req.query.search || "").trim().slice(0, 60);
    if (search) {
      where.push("(c.name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const outstandingOnly = String(req.query.outstandingOnly || "") === "1";

    const sortCol = CUSTOMER_SORTS[req.query.sortBy] || CUSTOMER_SORTS.billed;
    const sortDir = String(req.query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const groupedSql = `
      SELECT c.id, c.customer_code, c.name, c.phone, c.email, c.address, c.full_address, c.city,
             COUNT(*) AS order_count,
             COALESCE(SUM(t.grand_total), 0) AS billed,
             COALESCE(SUM(t.paid_amount), 0) AS paid,
             COALESCE(SUM(GREATEST(t.grand_total - t.paid_amount, 0)), 0) AS outstanding,
             MIN(t.order_date) AS first_order_at,
             MAX(t.order_date) AS last_order_at,
             GROUP_CONCAT(DISTINCT o.name ORDER BY o.name SEPARATOR ', ') AS event_names
      FROM tr_transaction t
      JOIN mst_customer c ON c.id = t.customer_id
      LEFT JOIN mst_outlet o ON o.id = t.outlet_id
      WHERE ${where.join(" AND ")}
      GROUP BY c.id, c.customer_code, c.name, c.phone, c.email, c.address, c.full_address, c.city
      ${outstandingOnly ? "HAVING outstanding > 0" : ""}`;

    const [[countRows], [rows], [totalsRows]] = await Promise.all([
      safeMyWaschenQuery(`SELECT COUNT(*) AS total FROM (${groupedSql}) x`, params),
      safeMyWaschenQuery(
        `${groupedSql} ORDER BY ${sortCol} ${sortDir}, c.id DESC LIMIT ? OFFSET ?`,
        [...params, limit, (page - 1) * limit]
      ),
      safeMyWaschenQuery(
        `SELECT COUNT(*) AS customers, COALESCE(SUM(order_count), 0) AS orders,
                COALESCE(SUM(billed), 0) AS billed, COALESCE(SUM(paid), 0) AS paid,
                COALESCE(SUM(outstanding), 0) AS outstanding,
                SUM(CASE WHEN outstanding > 0 THEN 1 ELSE 0 END) AS customers_outstanding
         FROM (${groupedSql}) x`,
        params
      ),
    ]);

    const total = Number(countRows[0]?.total) || 0;
    res.json({
      success: true,
      data: rows,
      totals: totalsRows[0] || {},
      meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error("getEventCustomers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
