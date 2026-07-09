import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/outlets -> Get active outlets
export const getOutlets = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM mst_outlet WHERE is_active = 1 AND deleted_at IS NULL ORDER BY id DESC"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getOutlets] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/outlets/admin/all -> Get all outlets (for admin list, including inactive/soft-deleted)
export const getAllOutlets = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM mst_outlet ORDER BY id DESC"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getAllOutlets] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/outlets -> Create a new outlet
export const createOutlet = async (req, res) => {
  try {
    const { outlet_code, name, address, phone, email, npwp, latitude, longitude } = req.body;
    if (!outlet_code || !name || !address) {
      return res.status(400).json({ success: false, message: "Code, Name, and Address are required." });
    }

    const [existing] = await safeMyWaschenQuery(
      "SELECT id FROM mst_outlet WHERE outlet_code = ? AND deleted_at IS NULL",
      [outlet_code]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: `Outlet with code ${outlet_code} already exists.` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_outlet (outlet_code, name, address, phone, email, npwp, latitude, longitude, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [outlet_code, name, address, phone || null, email || null, npwp || null, latitude || null, longitude || null]
    );

    // Also initialize empty cash balance in mst_outlet_cash_balance
    await safeMyWaschenQuery(
      "INSERT IGNORE INTO mst_outlet_cash_balance (outlet_id, balance) VALUES (?, 0.00)",
      [result.insertId]
    );

    return res.json({ success: true, message: "Outlet created successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[createOutlet] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/outlets/:id -> Update an outlet
export const updateOutlet = async (req, res) => {
  try {
    const { id } = req.params;
    const { outlet_code, name, address, phone, email, npwp, latitude, longitude, is_active } = req.body;

    const [existing] = await safeMyWaschenQuery(
      "SELECT id FROM mst_outlet WHERE id = ?",
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Outlet not found." });
    }

    // Check duplicate code
    if (outlet_code) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_outlet WHERE outlet_code = ? AND id != ? AND deleted_at IS NULL",
        [outlet_code, id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: `Outlet with code ${outlet_code} already exists.` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_outlet 
       SET outlet_code = COALESCE(?, outlet_code), 
           name = COALESCE(?, name), 
           address = COALESCE(?, address), 
           phone = ?, 
           email = ?, 
           npwp = ?, 
           latitude = ?, 
           longitude = ?, 
           is_active = COALESCE(?, is_active) 
       WHERE id = ?`,
      [outlet_code, name, address, phone, email, npwp, latitude, longitude, is_active, id]
    );

    return res.json({ success: true, message: "Outlet updated successfully" });
  } catch (err) {
    console.error("[updateOutlet] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/outlets/:id -> Soft delete outlet
export const deleteOutlet = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId || 1; // Fallback to 1 for tests/dev

    await safeMyWaschenQuery(
      "UPDATE mst_outlet SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?",
      [userId, id]
    );
    return res.json({ success: true, message: "Outlet soft-deleted successfully" });
  } catch (err) {
    console.error("[deleteOutlet] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
