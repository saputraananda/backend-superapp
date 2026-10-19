import { safeMyWaschenQuery } from "../../../db/pool.js";

/**
 * Tanggal pengajuan: "20", range "18-22", atau custom "1,3,5" (boleh campur "1-3,10").
 * Return string kanonik (urut, tanpa duplikat, range dipadatkan) atau null kalau tidak valid.
 */
function normalizeOpenDays(value) {
  const parts = String(value ?? "").replace(/\s+/g, "").split(",").filter(Boolean);
  if (!parts.length) return null;
  const days = new Set();
  for (const part of parts) {
    const m = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > 31 || from > to) return null;
    for (let d = from; d <= to; d += 1) days.add(d);
  }
  const sorted = [...days].sort((a, b) => a - b);
  const chunks = [];
  for (let i = 0; i < sorted.length; i += 1) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    chunks.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return chunks.join(",");
}

const OPEN_DAYS_ERROR = "Tanggal pengajuan tidak valid. Contoh: 20, 18-22, atau 1,3,5 (tanggal 1 sampai 31)";

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
      request_open_day = "20",
      min_notice_days = 1,
      allow_past_date_request = 0,
      is_active = 1,
      notes,
    } = req.body;

    const openDays = normalizeOpenDays(request_open_day);
    if (openDays == null) {
      return res.status(422).json({ success: false, message: OPEN_DAYS_ERROR });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_day_off_policy
       (outlet_id, role_id, max_days_per_month, request_open_day, min_notice_days, allow_past_date_request, is_active, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        outlet_id || null,
        role_id || null,
        Number(max_days_per_month) || 4,
        openDays,
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

    const openDays = normalizeOpenDays(request_open_day);
    if (openDays == null) {
      return res.status(422).json({ success: false, message: OPEN_DAYS_ERROR });
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
        openDays,
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
