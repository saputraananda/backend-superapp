import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/inventory/items -> List items
export const getInventoryItems = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT i.*, c.name as category_name
       FROM mst_inventory_item i
       LEFT JOIN mst_inventory_category c ON i.category_id = c.id
       WHERE i.deleted_at IS NULL
       ORDER BY i.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getInventoryItems] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/inventory/categories -> Get all categories
export const getInventoryCategories = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT id, code, name FROM mst_inventory_category WHERE is_active = 1 ORDER BY name ASC"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getInventoryCategories] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/inventory/items -> Create item
export const createInventoryItem = async (req, res) => {
  try {
    const { category_id, item_code, name, unit, tracking_type, default_cost, min_stock_default, is_auto_deduct, is_hpp_component } = req.body;
    const userId = req.session.userId || 1;

    if (!category_id || !item_code || !name || !unit) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_inventory_item WHERE item_code = ? AND deleted_at IS NULL",
      [item_code]
    );
    if (dup.length > 0) {
      return res.status(400).json({ success: false, message: `Item code ${item_code} already exists.` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_inventory_item (
        category_id, item_code, name, unit, tracking_type, default_cost, 
        min_stock_default, is_auto_deduct, is_hpp_component, is_active, created_by_data_analyst
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        category_id, item_code, name, unit, tracking_type || "real_time", default_cost || 0.00,
        min_stock_default || 0.00, is_auto_deduct || 0, is_hpp_component || 1, userId
      ]
    );

    return res.json({ success: true, message: "Inventory item created successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[createInventoryItem] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/inventory/items/:id -> Update item
export const updateInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, item_code, name, unit, tracking_type, default_cost, min_stock_default, is_auto_deduct, is_hpp_component, is_active } = req.body;

    const [existing] = await safeMyWaschenQuery("SELECT id FROM mst_inventory_item WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Item not found." });
    }

    if (item_code) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_inventory_item WHERE item_code = ? AND id != ? AND deleted_at IS NULL",
        [item_code, id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: `Item code ${item_code} already exists.` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_inventory_item 
       SET category_id = COALESCE(?, category_id),
           item_code = COALESCE(?, item_code),
           name = COALESCE(?, name),
           unit = COALESCE(?, unit),
           tracking_type = COALESCE(?, tracking_type),
           default_cost = COALESCE(?, default_cost),
           min_stock_default = COALESCE(?, min_stock_default),
           is_auto_deduct = COALESCE(?, is_auto_deduct),
           is_hpp_component = COALESCE(?, is_hpp_component),
           is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        category_id, item_code, name, unit, tracking_type, default_cost,
        min_stock_default, is_auto_deduct, is_hpp_component, is_active, id
      ]
    );

    return res.json({ success: true, message: "Inventory item updated successfully" });
  } catch (err) {
    console.error("[updateInventoryItem] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/inventory/items/:id -> Soft delete item
export const deleteInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.session.userId || 1;

    await safeMyWaschenQuery(
      "UPDATE mst_inventory_item SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?",
      [adminId, id]
    );
    return res.json({ success: true, message: "Inventory item soft-deleted successfully" });
  } catch (err) {
    console.error("[deleteInventoryItem] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/inventory/stocks -> Get stock per outlet
export const getInventoryStocks = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, o.name as outlet_name, i.name as item_name, i.item_code, i.unit, c.name as category_name
       FROM mst_inventory_outlet_stock s
       LEFT JOIN mst_outlet o ON s.outlet_id = o.id
       LEFT JOIN mst_inventory_item i ON s.inventory_id = i.id
       LEFT JOIN mst_inventory_category c ON i.category_id = c.id
       WHERE i.deleted_at IS NULL
       ORDER BY o.name ASC, i.name ASC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getInventoryStocks] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/inventory/adjust -> Stock adjustment (with movement ledger)
export const adjustStock = async (req, res) => {
  try {
    const { outlet_id, inventory_id, qty, movement_type, notes, unit_cost } = req.body;
    const userId = req.session.userId || 1;

    if (!outlet_id || !inventory_id || qty === undefined || !movement_type) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // Insert to movement ledger
    await safeMyWaschenQuery(
      `INSERT INTO tr_inventory_movement (outlet_id, inventory_id, movement_type, qty, unit_cost, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [outlet_id, inventory_id, movement_type, qty, unit_cost || null, notes || null, userId]
    );

    // Upsert to outlet stock
    await safeMyWaschenQuery(
      `INSERT INTO mst_inventory_outlet_stock (outlet_id, inventory_id, stock_qty, min_stock, last_cost)
       VALUES (?, ?, ?, 0.00, ?)
       ON DUPLICATE KEY UPDATE 
         stock_qty = stock_qty + VALUES(stock_qty),
         last_cost = VALUES(last_cost)`,
      [outlet_id, inventory_id, qty, unit_cost || 0.00]
    );

    return res.json({ success: true, message: "Stock adjusted successfully" });
  } catch (err) {
    console.error("[adjustStock] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
