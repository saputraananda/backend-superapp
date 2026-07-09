import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/purchase-requests -> Get list of purchase requests
export const getPurchaseRequests = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT pr.*, o.name as outlet_name, u_req.name as requester_name, 
              u_app.name as approver_name, u_ful.name as fulfiller_name, i.name as inventory_name
       FROM tr_purchase_request pr
       LEFT JOIN mst_outlet o ON pr.outlet_id = o.id
       LEFT JOIN mst_user u_req ON pr.requested_by = u_req.id
       LEFT JOIN mst_user u_app ON pr.approved_by = u_app.id
       LEFT JOIN mst_user u_ful ON pr.fulfilled_by = u_ful.id
       LEFT JOIN mst_inventory_item i ON pr.inventory_id = i.id
       WHERE pr.deleted_at IS NULL
       ORDER BY pr.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getPurchaseRequests] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/purchase-requests -> Create new purchase request
export const createPurchaseRequest = async (req, res) => {
  try {
    const { outlet_id, inventory_id, item_name, brand, category, qty, unit, estimated_price, urgency, reason } = req.body;
    const userId = req.session.userId || 1;

    if (!outlet_id || !item_name || !qty || !reason) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO tr_purchase_request (
        outlet_id, inventory_id, item_name, brand, category, qty, unit, 
        estimated_price, urgency, reason, status, requested_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        outlet_id, inventory_id || null, item_name, brand || null, category || null, qty, unit || 'pcs',
        estimated_price || null, urgency || 'normal', reason, userId
      ]
    );

    return res.json({ success: true, message: "Purchase request created successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[createPurchaseRequest] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/purchase-requests/:id/status -> Update status (approve, reject, or fulfill)
export const updatePurchaseStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, reject_reason, admin_note, approved_qty, fulfilled_amount, receipt_photo_url } = req.body;
    const userId = req.session.userId || 1;

    const [existing] = await safeMyWaschenQuery("SELECT id, status, outlet_id, inventory_id, approved_qty, unit FROM tr_purchase_request WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Purchase request not found." });
    }

    const request = existing[0];
    const updateFields = [];
    const params = [];

    if (status === 'approved') {
      updateFields.push("status = 'approved'", "approved_by = ?", "approved_qty = ?", "admin_note = ?", "resolved_at = NOW()");
      params.push(userId, approved_qty || request.qty, admin_note || null);
    } else if (status === 'rejected') {
      updateFields.push("status = 'rejected'", "approved_by = ?", "reject_reason = ?", "resolved_at = NOW()");
      params.push(userId, reject_reason || null);
    } else if (status === 'fulfilled') {
      updateFields.push("status = 'fulfilled'", "fulfilled_by = ?", "fulfilled_amount = ?", "receipt_photo_url = ?", "fulfilled_at = NOW()");
      params.push(userId, fulfilled_amount || null, receipt_photo_url || null);

      // If it is an inventory catalog item, automatically trigger inventory stock receipt!
      if (request.inventory_id) {
        const finalQty = parseFloat(request.approved_qty) || parseFloat(request.qty) || 0;
        
        // Insert movement
        await safeMyWaschenQuery(
          `INSERT INTO tr_inventory_movement (outlet_id, inventory_id, movement_type, qty, unit_cost, notes, created_by)
           VALUES (?, ?, 'receipt', ?, ?, 'Fulfilled purchase request', ?)`,
          [request.outlet_id, request.inventory_id, finalQty, fulfilled_amount ? (fulfilled_amount / finalQty) : 0, userId]
        );

        // Update outlet stock
        await safeMyWaschenQuery(
          `INSERT INTO mst_inventory_outlet_stock (outlet_id, inventory_id, stock_qty, min_stock, last_cost)
           VALUES (?, ?, ?, 0.00, ?)
           ON DUPLICATE KEY UPDATE 
             stock_qty = stock_qty + VALUES(stock_qty),
             last_cost = VALUES(last_cost)`,
          [request.outlet_id, request.inventory_id, finalQty, fulfilled_amount ? (fulfilled_amount / finalQty) : 0.00]
        );
      }
    } else {
      return res.status(400).json({ success: false, message: "Invalid or unsupported status transition." });
    }

    params.push(id);
    await safeMyWaschenQuery(
      `UPDATE tr_purchase_request SET ${updateFields.join(', ')} WHERE id = ?`,
      params
    );

    return res.json({ success: true, message: `Purchase request status updated to ${status}.` });
  } catch (err) {
    console.error("[updatePurchaseStatus] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
