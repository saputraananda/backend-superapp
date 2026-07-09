import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/services -> Get all services
export const getServices = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, o.name as outlet_name, c.name as category_name
       FROM mst_service s
       LEFT JOIN mst_outlet o ON s.outlet_id = o.id
       LEFT JOIN mst_service_category c ON s.category_id = c.id
       WHERE s.deleted_at IS NULL
       ORDER BY s.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getServices] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/services/categories -> Get all service categories
export const getServiceCategories = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT id, code, name FROM mst_service_category ORDER BY name ASC"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getServiceCategories] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/services -> Create a service
export const createService = async (req, res) => {
  try {
    const {
      outlet_id, category_id, service_code, name, unit_type, price,
      requires_material, min_qty, express_multiplier, is_express_eligible,
      is_requires_unit_detail, estimated_daily_qty, durasi_hari,
      sla_regular_hours, sla_express_hours, service_kind
    } = req.body;

    if (!outlet_id || !category_id || !service_code || !name || !unit_type || price === undefined) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_service WHERE outlet_id = ? AND service_code = ? AND deleted_at IS NULL",
      [outlet_id, service_code]
    );
    if (dup.length > 0) {
      return res.status(400).json({ success: false, message: `Service with code ${service_code} already exists for this outlet.` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_service (
        outlet_id, category_id, service_code, name, unit_type, price,
        requires_material, min_qty, express_multiplier, is_express_eligible,
        is_requires_unit_detail, estimated_daily_qty, durasi_hari,
        sla_regular_hours, sla_express_hours, service_kind, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        outlet_id, category_id, service_code, name, unit_type, price,
        requires_material || 0, min_qty || 1.00, express_multiplier || 2.00,
        is_express_eligible === undefined ? 1 : is_express_eligible,
        is_requires_unit_detail || 0, estimated_daily_qty || null, durasi_hari || 1,
        sla_regular_hours || null, sla_express_hours || null, service_kind || "waschen"
      ]
    );

    return res.json({ success: true, message: "Service created successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[createService] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/services/:id -> Update service
export const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      outlet_id, category_id, service_code, name, unit_type, price,
      requires_material, min_qty, express_multiplier, is_express_eligible,
      is_requires_unit_detail, estimated_daily_qty, durasi_hari,
      sla_regular_hours, sla_express_hours, service_kind, is_active
    } = req.body;

    const [existing] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found." });
    }

    if (outlet_id && service_code) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_service WHERE outlet_id = ? AND service_code = ? AND id != ? AND deleted_at IS NULL",
        [outlet_id, service_code, id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: `Service with code ${service_code} already exists for this outlet.` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_service 
       SET outlet_id = COALESCE(?, outlet_id),
           category_id = COALESCE(?, category_id),
           service_code = COALESCE(?, service_code),
           name = COALESCE(?, name),
           unit_type = COALESCE(?, unit_type),
           price = COALESCE(?, price),
           requires_material = COALESCE(?, requires_material),
           min_qty = COALESCE(?, min_qty),
           express_multiplier = COALESCE(?, express_multiplier),
           is_express_eligible = COALESCE(?, is_express_eligible),
           is_requires_unit_detail = COALESCE(?, is_requires_unit_detail),
           estimated_daily_qty = ?,
           durasi_hari = COALESCE(?, durasi_hari),
           sla_regular_hours = ?,
           sla_express_hours = ?,
           service_kind = COALESCE(?, service_kind),
           is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [
        outlet_id, category_id, service_code, name, unit_type, price,
        requires_material, min_qty, express_multiplier, is_express_eligible,
        is_requires_unit_detail, estimated_daily_qty, durasi_hari,
        sla_regular_hours, sla_express_hours, service_kind, is_active, id
      ]
    );

    return res.json({ success: true, message: "Service updated successfully" });
  } catch (err) {
    console.error("[updateService] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/services/:id -> Soft delete service
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.session.userId || 1;

    await safeMyWaschenQuery(
      "UPDATE mst_service SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?",
      [adminId, id]
    );
    return res.json({ success: true, message: "Service soft-deleted successfully" });
  } catch (err) {
    console.error("[deleteService] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
