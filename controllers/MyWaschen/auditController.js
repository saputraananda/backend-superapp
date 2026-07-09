import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/audit -> Get audit trail logs list
export const getAuditLogs = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT al.*, u.name as user_name, o.name as outlet_name, u_app.name as approved_by_name
       FROM tr_audit_log al
       LEFT JOIN mst_user u ON al.user_id = u.id
       LEFT JOIN mst_outlet o ON al.outlet_id = o.id
       LEFT JOIN mst_user u_app ON al.approved_by = u_app.id
       ORDER BY al.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getAuditLogs] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
