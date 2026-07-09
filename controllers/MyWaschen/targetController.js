import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/targets -> Get outlet target omzet lists
export const getTargets = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT t.*, o.name as outlet_name, u.name as creator_name
       FROM mst_outlet_target t
       LEFT JOIN mst_outlet o ON t.outlet_id = o.id
       LEFT JOIN mst_user u ON t.created_by = u.id
       WHERE t.deleted_at IS NULL
       ORDER BY t.period_year DESC, t.period_month DESC, o.name ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getTargets] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/targets -> Save/Update (upsert) target omzet
export const saveTarget = async (req, res) => {
  try {
    const { outlet_id, period_year, period_month, target_amount, notes } = req.body;
    const userId = req.session.userId || 1;

    if (!outlet_id || !period_year || !period_month || target_amount === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    await safeMyWaschenQuery(
      `INSERT INTO mst_outlet_target (outlet_id, period_year, period_month, target_amount, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
         target_amount = VALUES(target_amount),
         notes = VALUES(notes),
         created_by = VALUES(created_by),
         updated_at = CURRENT_TIMESTAMP`,
      [outlet_id, period_year, period_month, target_amount, notes || null, userId]
    );

    return res.json({ success: true, message: "Target omzet saved successfully" });
  } catch (err) {
    console.error("[saveTarget] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/targets/daily-progress -> Calculate daily revenue progress towards the monthly target
export const getDailyProgress = async (req, res) => {
  try {
    const { outlet_id, year, month } = req.query;

    const now = new Date();
    const queryYear = year ? parseInt(year) : now.getFullYear();
    const queryMonth = month ? parseInt(month) : (now.getMonth() + 1);

    // Get targets list
    let targetSql = `SELECT t.*, o.name as outlet_name 
                     FROM mst_outlet_target t 
                     JOIN mst_outlet o ON t.outlet_id = o.id 
                     WHERE t.period_year = ? AND t.period_month = ? AND t.deleted_at IS NULL`;
    const targetParams = [queryYear, queryMonth];
    if (outlet_id) {
      targetSql += " AND t.outlet_id = ?";
      targetParams.push(outlet_id);
    }
    const [targets] = await safeMyWaschenQuery(targetSql, targetParams);

    // Get actual revenue per outlet
    let revenueSql = `SELECT outlet_id, SUM(total) as actual_revenue, COUNT(id) as total_transactions
                      FROM tr_transaction
                      WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?
                        AND deleted_at IS NULL AND status != 'cancelled'
                      GROUP BY outlet_id`;
    const [revenues] = await safeMyWaschenQuery(revenueSql, [queryYear, queryMonth]);

    const revMap = revenues.reduce((map, r) => {
      map[r.outlet_id] = {
        actual_revenue: parseFloat(r.actual_revenue) || 0,
        total_transactions: r.total_transactions
      };
      return map;
    }, {});

    // Compute progress
    const data = targets.map(t => {
      const rev = revMap[t.outlet_id] || { actual_revenue: 0, total_transactions: 0 };
      const targetAmount = parseFloat(t.target_amount) || 0;
      const pct = targetAmount > 0 ? (rev.actual_revenue / targetAmount) * 100 : 0;
      
      return {
        id: t.id,
        outlet_id: t.outlet_id,
        outlet_name: t.outlet_name,
        period_year: t.period_year,
        period_month: t.period_month,
        target_amount: targetAmount,
        actual_revenue: rev.actual_revenue,
        total_transactions: rev.total_transactions,
        percentage: parseFloat(pct.toFixed(2)),
        notes: t.notes
      };
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[getDailyProgress] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
