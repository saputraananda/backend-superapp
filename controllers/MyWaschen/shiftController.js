import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/shifts/sessions -> Get cashier main sessions
export const getSessions = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT cs.*, o.name as outlet_name, u.name as cashier_name
       FROM tr_cashier_session cs
       LEFT JOIN mst_outlet o ON cs.outlet_id = o.id
       LEFT JOIN mst_user u ON cs.cashier_id = u.id
       WHERE cs.deleted_at IS NULL
       ORDER BY cs.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getSessions] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/shifts/sub-sessions -> Get cashier sub-sessions
export const getSubSessions = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT css.*, o.name as outlet_name, u.name as cashier_name, cs.session_date, cs.shift as parent_shift
       FROM tr_cashier_sub_session css
       LEFT JOIN mst_outlet o ON css.outlet_id = o.id
       LEFT JOIN mst_user u ON css.cashier_id = u.id
       LEFT JOIN tr_cashier_session cs ON css.session_id = cs.id
       ORDER BY css.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getSubSessions] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/shifts/handovers -> Get shift handovers
export const getHandovers = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT sh.*, 
              u_out.name as outgoing_cashier_name, 
              u_in.name as incoming_cashier_name,
              u_creator.name as creator_name
       FROM tr_shift_handover sh
       LEFT JOIN mst_user u_out ON sh.outgoing_cashier_id = u_out.id
       LEFT JOIN mst_user u_in ON sh.incoming_cashier_id = u_in.id
       LEFT JOIN mst_user u_creator ON sh.created_by = u_creator.id
       ORDER BY sh.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getHandovers] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
