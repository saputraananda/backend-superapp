import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/approvals -> Get all pending approvals (transactions, expenses, and deposits)
export const getPendingApprovals = async (req, res) => {
  try {
    // 1. Transaction Approvals (tr_transaction_approval)
    const [txApprovals] = await safeMyWaschenQuery(
      `SELECT ta.*, t.transaction_no, o.name as outlet_name, u.name as requester_name
       FROM tr_transaction_approval ta
       JOIN tr_transaction t ON ta.transaction_id = t.id
       LEFT JOIN mst_outlet o ON t.outlet_id = o.id
       LEFT JOIN mst_user u ON ta.requested_by = u.id
       WHERE ta.status = 'pending' AND ta.is_active = 1
       ORDER BY ta.requested_at DESC`
    );

    // 2. Expense Approvals (tr_outlet_cash_expense where status = 'pending_approval')
    const [expenseApprovals] = await safeMyWaschenQuery(
      `SELECT e.*, o.name as outlet_name, u.name as requester_name
       FROM tr_outlet_cash_expense e
       LEFT JOIN mst_outlet o ON e.outlet_id = o.id
       LEFT JOIN mst_user u ON e.requested_by = u.id
       WHERE e.status = 'pending_approval'
       ORDER BY e.created_at DESC`
    );

    // 3. Deposit Approvals (tr_cash_deposit where status = 'pending')
    const [depositApprovals] = await safeMyWaschenQuery(
      `SELECT cd.*, o.name as outlet_name, u.name as cashier_name
       FROM tr_cash_deposit cd
       LEFT JOIN mst_outlet o ON cd.outlet_id = o.id
       LEFT JOIN mst_user u ON cd.cashier_id = u.id
       WHERE cd.status = 'pending' AND cd.deleted_at IS NULL
       ORDER BY cd.created_at DESC`
    );

    return res.json({
      success: true,
      data: {
        transactions: txApprovals,
        expenses: expenseApprovals,
        deposits: depositApprovals
      }
    });
  } catch (err) {
    console.error("[getPendingApprovals] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/approvals/:id/resolve -> Approve or Reject a transaction request
export const resolveApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reject_reason } = req.body;
    const userId = req.session.userId || 1;

    if (!status || !['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be 'approved' or 'rejected'." });
    }

    const [approvalRow] = await safeMyWaschenQuery(
      "SELECT * FROM tr_transaction_approval WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (approvalRow.length === 0) {
      return res.status(404).json({ success: false, message: "Pending approval request not found." });
    }

    const appRequest = approvalRow[0];

    // Begin updates
    if (status === 'approved') {
      const txId = appRequest.transaction_id;
      
      if (appRequest.type === 'cancel_nota') {
        // Set transaction status to cancelled
        await safeMyWaschenQuery(
          "UPDATE tr_transaction SET status = 'cancelled', cancelled_by = ?, cancelled_at = NOW() WHERE id = ?",
          [userId, txId]
        );
      } else if (appRequest.type === 'delete_transaction') {
        // Soft delete transaction
        await safeMyWaschenQuery(
          "UPDATE tr_transaction SET deleted_at = NOW(), deleted_by = ?, delete_reason = ? WHERE id = ?",
          [userId, appRequest.reason, txId]
        );
      } else if (appRequest.type === 'payment_void') {
        // Void transaction payments
        await safeMyWaschenQuery(
          "UPDATE tr_payment_item SET status = 'void', deleted_at = NOW(), deleted_by = ? WHERE transaction_id = ?",
          [userId, txId]
        );
        await safeMyWaschenQuery(
          "UPDATE tr_transaction SET payment_status = 'void' WHERE id = ?",
          [txId]
        );
      }
    }

    // Resolve the approval record
    await safeMyWaschenQuery(
      `UPDATE tr_transaction_approval 
       SET status = ?, approved_by = ?, reject_reason = ?, resolved_at = NOW() 
       WHERE id = ?`,
      [status, userId, reject_reason || null, id]
    );

    return res.json({ success: true, message: `Request successfully ${status}` });
  } catch (err) {
    console.error("[resolveApproval] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cash-deposits/:id/approve -> Approve cash deposit
export const approveCashDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId || 1;

    const [depositRow] = await safeMyWaschenQuery(
      "SELECT id FROM tr_cash_deposit WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (depositRow.length === 0) {
      return res.status(404).json({ success: false, message: "Pending deposit not found." });
    }

    await safeMyWaschenQuery(
      "UPDATE tr_cash_deposit SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?",
      [userId, id]
    );

    return res.json({ success: true, message: "Cash deposit approved successfully." });
  } catch (err) {
    console.error("[approveCashDeposit] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/cash-deposits/:id/reject -> Reject cash deposit
export const rejectCashDeposit = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.session.userId || 1;

    const [depositRow] = await safeMyWaschenQuery(
      "SELECT id FROM tr_cash_deposit WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (depositRow.length === 0) {
      return res.status(404).json({ success: false, message: "Pending deposit not found." });
    }

    await safeMyWaschenQuery(
      "UPDATE tr_cash_deposit SET status = 'rejected', rejected_by = ?, rejected_at = NOW(), reject_reason = ? WHERE id = ?",
      [userId, id, reason || null]
    );

    return res.json({ success: true, message: "Cash deposit rejected successfully." });
  } catch (err) {
    console.error("[rejectCashDeposit] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/finance/expenses/:id/approve -> Approve expense
export const approveExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId || 1;

    const [expenseRow] = await safeMyWaschenQuery(
      "SELECT id, outlet_id, amount FROM tr_outlet_cash_expense WHERE id = ? AND status = 'pending_approval'",
      [id]
    );
    if (expenseRow.length === 0) {
      return res.status(404).json({ success: false, message: "Pending expense not found." });
    }

    const { outlet_id, amount } = expenseRow[0];

    // Deduct from outlet cash balance
    await safeMyWaschenQuery(
      `INSERT INTO mst_outlet_cash_balance (outlet_id, balance) VALUES (?, 0.00)
       ON DUPLICATE KEY UPDATE 
         balance = balance - ?,
         last_expense_at = NOW()`,
      [outlet_id, amount]
    );

    await safeMyWaschenQuery(
      "UPDATE tr_outlet_cash_expense SET status = 'approved', approved_by = ?, resolved_at = NOW() WHERE id = ?",
      [userId, id]
    );

    return res.json({ success: true, message: "Expense approved successfully." });
  } catch (err) {
    console.error("[approveExpense] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/finance/expenses/:id/reject -> Reject expense
export const rejectExpense = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.session.userId || 1;

    const [expenseRow] = await safeMyWaschenQuery(
      "SELECT id FROM tr_outlet_cash_expense WHERE id = ? AND status = 'pending_approval'",
      [id]
    );
    if (expenseRow.length === 0) {
      return res.status(404).json({ success: false, message: "Pending expense not found." });
    }

    await safeMyWaschenQuery(
      "UPDATE tr_outlet_cash_expense SET status = 'rejected', approved_by = ?, reject_reason = ?, resolved_at = NOW() WHERE id = ?",
      [userId, reason || null, id]
    );

    return res.json({ success: true, message: "Expense rejected successfully." });
  } catch (err) {
    console.error("[rejectExpense] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
