import { safeQuery } from "../db/pool.js";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/employee-mood/today — ambil mood employee hari ini
// ═══════════════════════════════════════════════════════════════════════════
export const getTodayMood = async (req, res) => {
  try {
    const employeeId = req.session.employeeId;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const [rows] = await safeQuery(
      `SELECT id, mood_level, mood_date, created_at
       FROM tr_employee_mood
       WHERE employee_id = ? AND mood_date = CURDATE()
       LIMIT 1`,
      [employeeId]
    );

    return res.json({
      success: true,
      data: rows.length > 0 ? rows[0] : null,
    });
  } catch (err) {
    console.error("[getTodayMood] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/employee-mood — simpan / update mood hari ini (upsert)
// ═══════════════════════════════════════════════════════════════════════════
export const saveMood = async (req, res) => {
  try {
    const employeeId = req.session.employeeId;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const { mood_level } = req.body;

    // Validasi mood_level
    const allowedMoods = [
      "lagi_bersinar",
      "santai_positif",
      "mode_standar",
      "agak_mendung",
      "cuaca_hati_kurang_baik",
    ];
    if (!allowedMoods.includes(mood_level)) {
      return res.status(400).json({ success: false, message: "Pilihan mood tidak valid" });
    }

    // Upsert — 1 baris per employee per hari
    await safeQuery(
      `INSERT INTO tr_employee_mood (employee_id, mood_level, mood_date)
       VALUES (?, ?, CURDATE())
       ON DUPLICATE KEY UPDATE
         mood_level = VALUES(mood_level),
         updated_at = CURRENT_TIMESTAMP`,
      [employeeId, mood_level]
    );

    return res.json({ success: true, message: "Mood berhasil disimpan" });
  } catch (err) {
    console.error("[saveMood] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/employee-mood/stats — ringkasan mood bulan ini (buat report nanti)
// ═══════════════════════════════════════════════════════════════════════════
export const getMoodStats = async (req, res) => {
  try {
    const employeeId = req.session.employeeId;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const [rows] = await safeQuery(
      `SELECT mood_level, COUNT(*) AS total
       FROM tr_employee_mood
       WHERE employee_id = ?
         AND YEAR(mood_date) = YEAR(CURDATE())
         AND MONTH(mood_date) = MONTH(CURDATE())
       GROUP BY mood_level
       ORDER BY total DESC`,
      [employeeId]
    );

    const totalEntries = rows.reduce((sum, r) => sum + Number(r.total), 0);

    return res.json({
      success: true,
      data: {
        total_entries: totalEntries,
        breakdown: rows,
      },
    });
  } catch (err) {
    console.error("[getMoodStats] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
