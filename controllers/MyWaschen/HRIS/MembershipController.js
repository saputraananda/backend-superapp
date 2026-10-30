import { safeMyWaschenQuery } from "../../../db/pool.js";
import { posFileUrl } from "../../../utils/waschenPosUpload.js";

/** Membership terbaru (non-Cancelled) per customer — definisi "member" sama dengan Data Customer. */
const LATEST_MEMBERSHIP = `
  (SELECT m.*
   FROM tr_membership m
   INNER JOIN (
     SELECT customer_id, MAX(id) AS id
     FROM tr_membership
     WHERE status <> 'Cancelled'
     GROUP BY customer_id
   ) latest ON latest.id = m.id) tm
`;

const EXPIRED_EXPR = "(tm.status <> 'Active' OR tm.end_date < CURDATE())";

/**
 * Total top-up saldo per customer. Tidak difilter membership_id: top-up hasil migrasi Smartlink
 * ("Pembelian e-money Smartlink | MEMBER DIAMOND") tidak terhubung ke tr_membership.
 */
const TOPUP_TOTAL = `(SELECT COALESCE(SUM(d.amount), 0) FROM tr_customer_deposit d
   WHERE d.customer_id = tm.customer_id AND d.type = 'Topup')`;

const FROM_SQL = `
  FROM ${LATEST_MEMBERSHIP}
  JOIN mst_customer c ON c.id = tm.customer_id
  LEFT JOIN mst_membership_package mp ON mp.id = tm.package_id
  LEFT JOIN mst_outlet o ON o.id = c.preferred_outlet_id
`;

const SORT_EXPR = {
  name: "c.name",
  customer_code: "c.customer_code",
  start_date: "tm.start_date",
  end_date: "tm.end_date",
  total_topup: TOPUP_TOTAL,
  deposit_balance: "c.deposit_balance",
  tier: "mp.tier",
};

/** GET /waschen/memberships — daftar member (satu baris per customer). */
export const getMemberships = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const outletId = req.query.outletId;
    const packageId = req.query.packageId;
    const status = String(req.query.status || "").trim(); // aktif | berakhir
    const dateFrom = String(req.query.dateFrom || "").trim().slice(0, 10);
    const dateTo = String(req.query.dateTo || "").trim().slice(0, 10);
    const sortExpr = SORT_EXPR[String(req.query.sortBy || "")] || "tm.start_date";
    const sortDir = String(req.query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
    // limit=all → semua baris (satu halaman); selain itu maks 200 per halaman
    const all = String(req.query.limit || "").toLowerCase() === "all";
    const limit = all ? 100000 : Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const page = all ? 1 : Math.max(1, parseInt(req.query.page, 10) || 1);

    const where = [];
    const params = [];

    if (search) {
      where.push("(c.customer_code LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.address LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (outletId) {
      where.push("c.preferred_outlet_id = ?");
      params.push(Number(outletId));
    }
    if (packageId) {
      where.push("tm.package_id = ?");
      params.push(Number(packageId));
    }
    if (status === "aktif") where.push(`NOT ${EXPIRED_EXPR}`);
    if (status === "berakhir") where.push(EXPIRED_EXPR);
    if (dateFrom) {
      where.push("DATE(tm.start_date) >= ?");
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push("DATE(tm.start_date) <= ?");
      params.push(dateTo);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[stats]] = await safeMyWaschenQuery(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(NOT ${EXPIRED_EXPR}), 0) AS active,
              COALESCE(SUM(${EXPIRED_EXPR}), 0) AS expired,
              COALESCE(SUM(${TOPUP_TOTAL}), 0) AS top_up_total
       ${FROM_SQL} ${whereSql}`,
      params
    );

    const [tierRows] = await safeMyWaschenQuery(
      `SELECT COALESCE(mp.tier, 'Tanpa Paket') AS tier, COUNT(*) AS n
       ${FROM_SQL} ${whereSql}
       GROUP BY 1 ORDER BY n DESC`,
      params
    );

    const [rows] = await safeMyWaschenQuery(
      `SELECT tm.id AS membership_id, tm.customer_id, tm.status, tm.start_date, tm.end_date, ${TOPUP_TOTAL} AS total_topup,
              ${EXPIRED_EXPR} AS expired,
              DATEDIFF(tm.end_date, CURDATE()) AS days_left,
              c.customer_code, c.name, c.phone, c.deposit_balance, c.address, c.full_address, c.city,
              o.name AS outlet_name,
              mp.id AS package_id, mp.name AS package_name, mp.tier AS package_tier
       ${FROM_SQL} ${whereSql}
       ORDER BY ${sortExpr} ${sortDir}, tm.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    res.json({
      success: true,
      data: rows,
      meta: {
        total: Number(stats.total) || 0,
        page,
        limit,
        active: Number(stats.active) || 0,
        expired: Number(stats.expired) || 0,
        topUpTotal: Number(stats.top_up_total) || 0,
        tiers: tierRows.map((r) => ({ tier: r.tier, count: Number(r.n) || 0 })),
      },
    });
  } catch (err) {
    console.error("getMemberships error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/memberships/:customerId/payments — riwayat top-up/aktivasi + bukti pembayaran. */
export const getMembershipPayments = async (req, res) => {
  try {
    const { customerId } = req.params;
    const [rows] = await safeMyWaschenQuery(
      `SELECT d.id, d.amount, d.payment_method, d.payment_proof_url, d.notes, d.created_at,
              mp.name AS package_name, mp.tier AS package_tier
       FROM tr_customer_deposit d
       LEFT JOIN tr_membership m ON m.id = d.membership_id
       LEFT JOIN mst_membership_package mp ON mp.id = m.package_id
       WHERE d.customer_id = ? AND d.type = 'Topup' AND d.amount > 0
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT 100`,
      [customerId]
    );
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, payment_proof_url: posFileUrl(r.payment_proof_url) })),
    });
  } catch (err) {
    console.error("getMembershipPayments error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
