import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/finance/expenses -> Get outlet expenses (tr_outlet_cash_expense)
export const getExpenses = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT e.*, o.name as outlet_name, u_req.name as requester_name, u_app.name as approver_name
       FROM tr_outlet_cash_expense e
       LEFT JOIN mst_outlet o ON e.outlet_id = o.id
       LEFT JOIN mst_user u_req ON e.requested_by = u_req.id
       LEFT JOIN mst_user u_app ON e.approved_by = u_app.id
       ORDER BY e.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getExpenses] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/finance/deposits -> Get cash deposits (tr_cash_deposit)
export const getDeposits = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT cd.*, o.name as outlet_name, u_cash.name as cashier_name, u_app.name as approved_by_name
       FROM tr_cash_deposit cd
       LEFT JOIN mst_outlet o ON cd.outlet_id = o.id
       LEFT JOIN mst_user u_cash ON cd.cashier_id = u_cash.id
       LEFT JOIN mst_user u_app ON cd.approved_by = u_app.id
       WHERE cd.deleted_at IS NULL
       ORDER BY cd.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getDeposits] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/finance/wallet-ledgers -> Get customer wallet transactions (tr_wallet_ledger)
export const getWalletLedgers = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT wl.*, c.name as customer_name, c.phone as customer_phone, u.name as creator_name
       FROM tr_wallet_ledger wl
       LEFT JOIN mst_customer c ON wl.customer_id = c.id
       LEFT JOIN mst_user u ON wl.created_by = u.id
       ORDER BY wl.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getWalletLedgers] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
