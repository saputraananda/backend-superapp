import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/periods -> Get all closed periods
export const getPeriods = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT pc.*, o.name as outlet_name, u.name as closed_by_name
       FROM tr_period_close pc
       LEFT JOIN mst_outlet o ON pc.outlet_id = o.id
       LEFT JOIN mst_user u ON pc.closed_by = u.id
       ORDER BY pc.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getPeriods] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/periods/close -> Perform period closing computations and insert record
export const closePeriod = async (req, res) => {
  try {
    const { outlet_id, period_label, period_start, period_end, notes } = req.body;
    const userId = req.session.userId || 1;

    if (!outlet_id || !period_label || !period_start || !period_end) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // 1. Calculate transaction counts and totals
    const [stats] = await safeMyWaschenQuery(
      `SELECT 
         COUNT(id) as total_tx,
         SUM(total) as total_omset,
         SUM(paid_amount) as total_paid,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as total_done
       FROM tr_transaction
       WHERE outlet_id = ? 
         AND created_at >= ? 
         AND created_at <= ?
         AND deleted_at IS NULL 
         AND status != 'cancelled'`,
      [outlet_id, `${period_start} 00:00:00`, `${period_end} 23:59:59`]
    );

    const totalTx = stats[0]?.total_tx || 0;
    const totalOmset = stats[0]?.total_omset || 0.00;
    const totalPaid = stats[0]?.total_paid || 0.00;
    const totalDone = stats[0]?.total_done || 0;

    // 2. Fetch the target omzet for the period start month/year (if set)
    const startDate = new Date(period_start);
    const year = startDate.getFullYear();
    const month = startDate.getMonth() + 1;

    const [targetRow] = await safeMyWaschenQuery(
      `SELECT target_amount FROM mst_outlet_target 
       WHERE outlet_id = ? AND period_year = ? AND period_month = ? AND deleted_at IS NULL`,
      [outlet_id, year, month]
    );
    const targetAmount = targetRow[0]?.target_amount || null;

    // 3. Save period close record
    const [result] = await safeMyWaschenQuery(
      `INSERT INTO tr_period_close (
        outlet_id, period_label, period_start, period_end, total_omset,
        total_pelunasan, total_transaksi, total_selesai, target_amount, notes, closed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outlet_id, period_label, period_start, period_end, totalOmset,
        totalPaid, totalTx, totalDone, targetAmount, notes || null, userId
      ]
    );

    return res.json({ 
      success: true, 
      message: "Accounting period closed successfully", 
      data: { 
        id: result.insertId,
        total_omset: totalOmset,
        total_pelunasan: totalPaid,
        total_transaksi: totalTx,
        total_selesai: totalDone
      } 
    });
  } catch (err) {
    console.error("[closePeriod] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
