import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/dashboard/stats -> General summary statistics
export const getDashboardStats = async (req, res) => {
  try {
    const { outlet_id } = req.query;
    const params = [];
    let outletFilter = "";
    if (outlet_id) {
      outletFilter = "AND outlet_id = ?";
      params.push(outlet_id);
    }

    // 1. Total Revenue
    const [revResult] = await safeMyWaschenQuery(
      `SELECT SUM(total) as revenue FROM tr_transaction WHERE deleted_at IS NULL AND status != 'cancelled' ${outletFilter}`,
      params
    );
    const revenue = parseFloat(revResult[0]?.revenue) || 0;

    // 2. Total Transactions
    const [countResult] = await safeMyWaschenQuery(
      `SELECT COUNT(id) as count FROM tr_transaction WHERE deleted_at IS NULL AND status != 'cancelled' ${outletFilter}`,
      params
    );
    const txCount = countResult[0]?.count || 0;

    // 3. Active Outlets
    const [outletResult] = await safeMyWaschenQuery(
      "SELECT COUNT(id) as count FROM mst_outlet WHERE is_active = 1 AND deleted_at IS NULL"
    );
    const activeOutlets = outletResult[0]?.count || 0;

    // 4. Active Users
    const [userResult] = await safeMyWaschenQuery(
      "SELECT COUNT(id) as count FROM mst_user WHERE is_active = 1 AND deleted_at IS NULL"
    );
    const activeUsers = userResult[0]?.count || 0;

    return res.json({
      success: true,
      data: {
        total_revenue: revenue,
        total_transactions: txCount,
        active_outlets: activeOutlets,
        active_users: activeUsers
      }
    });
  } catch (err) {
    console.error("[getDashboardStats] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/admin-dashboard/charts -> Time-series and comparison charts data
export const getAdminCharts = async (req, res) => {
  try {
    const { outlet_id, limit } = req.query;
    const params = [];
    let outletFilter = "";
    if (outlet_id) {
      outletFilter = "AND t.outlet_id = ?";
      params.push(outlet_id);
    }

    // Monthly trends (last 6 months)
    const [monthlyTrends] = await safeMyWaschenQuery(
      `SELECT 
         DATE_FORMAT(t.created_at, '%Y-%m') as month,
         SUM(t.total) as revenue,
         COUNT(t.id) as transactions
       FROM tr_transaction t
       WHERE t.deleted_at IS NULL AND t.status != 'cancelled' ${outletFilter}
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
      [...params, parseInt(limit) || 6]
    );

    // Outlet comparison (Revenue contribution per active outlet)
    const [outletRev] = await safeMyWaschenQuery(
      `SELECT 
         o.name as outlet_name,
         SUM(t.total) as revenue,
         COUNT(t.id) as transactions
       FROM tr_transaction t
       JOIN mst_outlet o ON t.outlet_id = o.id
       WHERE t.deleted_at IS NULL AND t.status != 'cancelled'
       GROUP BY o.name
       ORDER BY revenue DESC`
    );

    // Payment methods breakdown
    const [paymentBreakdown] = await safeMyWaschenQuery(
      `SELECT 
         p.method,
         SUM(p.amount) as total_amount,
         COUNT(p.id) as total_count
       FROM tr_payment_item p
       JOIN tr_transaction t ON p.transaction_id = t.id
       WHERE p.deleted_at IS NULL AND p.status = 'paid' ${outletFilter}
       GROUP BY p.method
       ORDER BY total_amount DESC`,
      params
    );

    return res.json({
      success: true,
      data: {
        monthly_trends: monthlyTrends.reverse(),
        outlet_comparison: outletRev,
        payment_methods: paymentBreakdown
      }
    });
  } catch (err) {
    console.error("[getAdminCharts] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
