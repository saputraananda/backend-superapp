import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/reports/transactions -> Get detailed transaction report
export const getTransactionReport = async (req, res) => {
  try {
    const { outlet_id, status, start_date, end_date } = req.query;

    let sql = `SELECT t.*, o.name as outlet_name, c.name as customer_name, u.name as cashier_name
               FROM tr_transaction t
               LEFT JOIN mst_outlet o ON t.outlet_id = o.id
               LEFT JOIN mst_customer c ON t.customer_id = c.id
               LEFT JOIN mst_user u ON t.cashier_id = u.id
               WHERE t.deleted_at IS NULL`;
    const params = [];

    if (outlet_id) {
      sql += " AND t.outlet_id = ?";
      params.push(outlet_id);
    }
    if (status) {
      sql += " AND t.status = ?";
      params.push(status);
    }
    if (start_date) {
      sql += " AND t.created_at >= ?";
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      sql += " AND t.created_at <= ?";
      params.push(`${end_date} 23:59:59`);
    }

    sql += " ORDER BY t.id DESC";

    const [rows] = await safeMyWaschenQuery(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getTransactionReport] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/reports/payments -> Get payment methods report
export const getPaymentReport = async (req, res) => {
  try {
    const { outlet_id, start_date, end_date } = req.query;

    let sql = `SELECT p.*, t.transaction_no, o.name as outlet_name, u.name as recorder_name
               FROM tr_payment_item p
               JOIN tr_transaction t ON p.transaction_id = t.id
               LEFT JOIN mst_outlet o ON t.outlet_id = o.id
               LEFT JOIN mst_user u ON p.recorded_by = u.id
               WHERE p.deleted_at IS NULL`;
    const params = [];

    if (outlet_id) {
      sql += " AND t.outlet_id = ?";
      params.push(outlet_id);
    }
    if (start_date) {
      sql += " AND p.recorded_at >= ?";
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      sql += " AND p.recorded_at <= ?";
      params.push(`${end_date} 23:59:59`);
    }

    sql += " ORDER BY p.id DESC";

    const [rows] = await safeMyWaschenQuery(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getPaymentReport] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/reports/logistics -> Get logistic/delivery orders report
export const getLogisticReport = async (req, res) => {
  try {
    const { outlet_id, status, start_date, end_date } = req.query;

    let sql = `SELECT l.*, t.transaction_no, u_cour.name as courier_name, u_creator.name as creator_name
               FROM tr_logistic_order l
               JOIN tr_transaction t ON l.transaction_id = t.id
               LEFT JOIN mst_user u_cour ON l.courier_id = u_cour.id
               LEFT JOIN mst_user u_creator ON l.created_by = u_creator.id
               WHERE l.deleted_at IS NULL`;
    const params = [];

    if (outlet_id) {
      sql += " AND t.outlet_id = ?";
      params.push(outlet_id);
    }
    if (status) {
      sql += " AND l.status = ?";
      params.push(status);
    }
    if (start_date) {
      sql += " AND l.scheduled_at >= ?";
      params.push(`${start_date} 00:00:00`);
    }
    if (end_date) {
      sql += " AND l.scheduled_at <= ?";
      params.push(`${end_date} 23:59:59`);
    }

    sql += " ORDER BY l.id DESC";

    const [rows] = await safeMyWaschenQuery(sql, params);
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getLogisticReport] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
