import { safeMyWaschenQuery } from "../../../db/pool.js";

function requestOpenDay(value, fallback = 20) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 31) return fallback;
  return n;
}

export const getDayOffPolicies = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_day_off_policy ORDER BY policy_id ASC`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createDayOffPolicy = async (req, res) => {
  try {
    const {
      outlet_id,
      role_id,
      max_days_per_month = 4,
      request_open_day = 20,
      min_notice_days = 1,
      allow_past_date_request = 0,
      is_active = 1,
      notes,
    } = req.body;

    const openDay = requestOpenDay(request_open_day, null);
    if (openDay == null) {
      return res.status(422).json({ success: false, message: "Tanggal pengajuan harus antara 1 dan 31" });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_day_off_policy
       (outlet_id, role_id, max_days_per_month, request_open_day, min_notice_days, allow_past_date_request, is_active, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outlet_id || null,
        role_id || null,
        Number(max_days_per_month) || 4,
        openDay,
        Number(min_notice_days) || 1,
        Number(allow_past_date_request) ? 1 : 0,
        Number(is_active) ? 1 : 0,
        notes || null,
      ],
    );
    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM mst_day_off_policy WHERE policy_id = ?",
      [result.insertId],
    );
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateDayOffPolicy = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      outlet_id,
      role_id,
      max_days_per_month,
      request_open_day,
      min_notice_days,
      allow_past_date_request,
      is_active,
      notes,
    } = req.body;

    const openDay = requestOpenDay(request_open_day, null);
    if (openDay == null) {
      return res.status(422).json({ success: false, message: "Tanggal pengajuan harus antara 1 dan 31" });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_day_off_policy SET
         outlet_id = ?, role_id = ?, max_days_per_month = ?, request_open_day = ?, min_notice_days = ?,
         allow_past_date_request = ?, is_active = ?, notes = ?
       WHERE policy_id = ?`,
      [
        outlet_id || null,
        role_id || null,
        Number(max_days_per_month) || 4,
        openDay,
        Number(min_notice_days) || 1,
        Number(allow_past_date_request) ? 1 : 0,
        Number(is_active) ? 1 : 0,
        notes || null,
        id,
      ],
    );
    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM mst_day_off_policy WHERE policy_id = ?",
      [id],
    );
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteDayOffPolicy = async (req, res) => {
  try {
    const id = Number(req.params.id);
    await safeMyWaschenQuery("DELETE FROM mst_day_off_policy WHERE policy_id = ?", [id]);
    return res.json({ success: true, message: "Rules libur dihapus" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
