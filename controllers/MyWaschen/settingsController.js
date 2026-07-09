import { safeMyWaschenQuery } from "../../db/pool.js";

// GET /api/settings -> Get all settings
export const getSettings = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT id, setting_key, setting_value, data_type, description, category FROM mst_setting"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getSettings] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/settings -> Save settings (upsert or bulk save)
export const saveSettings = async (req, res) => {
  try {
    const { settings } = req.body; // Array of { key, value }
    const userId = req.session.userId || 1;

    if (!settings || !Array.isArray(settings)) {
      return res.status(400).json({ success: false, message: "Settings array is required." });
    }

    for (const item of settings) {
      await safeMyWaschenQuery(
        `INSERT INTO mst_setting (setting_key, setting_value, data_type, updated_by)
         VALUES (?, ?, 'string', ?)
         ON DUPLICATE KEY UPDATE 
           setting_value = VALUES(setting_value),
           updated_by = VALUES(updated_by),
           updated_at = CURRENT_TIMESTAMP`,
        [item.key, String(item.value), userId]
      );
    }

    return res.json({ success: true, message: "Settings saved successfully." });
  } catch (err) {
    console.error("[saveSettings] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
