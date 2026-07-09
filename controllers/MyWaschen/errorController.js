import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/errors -> Get all application error logs
export const getErrorLogs = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT e.*, u.name as resolved_by_name
       FROM tr_error_log e
       LEFT JOIN mst_user u ON e.resolved_by = u.id
       ORDER BY e.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getErrorLogs] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/errors/:id/resolve -> Resolve error log entry
export const resolveError = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.session.userId || 1;

    const [existing] = await safeMyWaschenQuery(
      "SELECT id FROM tr_error_log WHERE id = ? AND status != 'resolved'",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Error log not found or already resolved." });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_error_log 
       SET status = 'resolved', resolved_by = ?, resolution_notes = ?, resolved_at = NOW()
       WHERE id = ?`,
      [userId, notes || null, id]
    );

    return res.json({ success: true, message: "Error marked as resolved successfully." });
  } catch (err) {
    console.error("[resolveError] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
