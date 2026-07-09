import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/master/outlets -> Get all active outlets
export const getActiveOutlets = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT id, outlet_code, name FROM mst_outlet WHERE is_active = 1 AND deleted_at IS NULL ORDER BY name ASC"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getActiveOutlets] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
