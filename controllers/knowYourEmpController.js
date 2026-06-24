import { safeQuery } from "../db/pool.js";

// ═══════════════════════════════════════════════════════════════════════════
// GET /know-your-employee/mood — daftar mood semua karyawan (HR/Admin view)
// Query params: page, limit, search, mood_level, date_from, date_to, company_id
// ═══════════════════════════════════════════════════════════════════════════
export const getAllEmployeeMoods = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      search = "",
      mood_level = "",
      date_from = "",
      date_to = "",
      company_id = "",
    } = req.query;

    const offset = (Number(page) - 1) * Number(limit);

    const conditions = [];
    const params = [];

    if (search) {
      conditions.push(
        "(e.full_name LIKE ? OR e.employee_code LIKE ? OR p.position_name LIKE ?)"
      );
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (mood_level) {
      conditions.push("tm.mood_level = ?");
      params.push(mood_level);
    }
    if (date_from) {
      conditions.push("tm.mood_date >= ?");
      params.push(date_from);
    }
    if (date_to) {
      conditions.push("tm.mood_date <= ?");
      params.push(date_to);
    }
    if (company_id) {
      conditions.push("e.company_id = ?");
      params.push(company_id);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const dataQuery = `
      SELECT
        tm.id,
        tm.mood_level,
        tm.mood_date,
        tm.created_at,
        tm.updated_at,
        e.employee_id,
        e.full_name,
        e.employee_code,
        p.position_name,
        d.department_name,
        e.company_id,
        c.company_name
      FROM tr_employee_mood tm
      JOIN mst_employee e ON tm.employee_id = e.employee_id
      LEFT JOIN mst_position p ON e.position_id = p.position_id
      LEFT JOIN mst_department d ON e.department_id = d.department_id
      LEFT JOIN mst_company c ON e.company_id = c.company_id
      ${whereClause}
      ORDER BY tm.mood_date DESC, e.full_name ASC
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM tr_employee_mood tm
      JOIN mst_employee e ON tm.employee_id = e.employee_id
      LEFT JOIN mst_position p ON e.position_id = p.position_id
      LEFT JOIN mst_department d ON e.department_id = d.department_id
      ${whereClause}
    `;

    const [rows] = await safeQuery(dataQuery, [...params, Number(limit), offset]);
    const [[{ total }]] = await safeQuery(countQuery, params);

    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: Number(total),
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(Number(total) / Number(limit)),
      },
    });
  } catch (err) {
    console.error("[getAllEmployeeMoods] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /know-your-employee/mood/today — mood semua karyawan hari ini
// ═══════════════════════════════════════════════════════════════════════════
export const getTodayTeamMood = async (req, res) => {
  try {
    const { company_id = "" } = req.query;

    const conditions = ["tm.mood_date = CURDATE()"];
    const params = [];

    if (company_id) {
      conditions.push("e.company_id = ?");
      params.push(company_id);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const [rows] = await safeQuery(
      `SELECT
        tm.id,
        tm.mood_level,
        tm.mood_date,
        tm.created_at,
        e.employee_id,
        e.full_name,
        e.employee_code,
        p.position_name,
        d.department_name,
        c.company_name
      FROM tr_employee_mood tm
      JOIN mst_employee e ON tm.employee_id = e.employee_id
      LEFT JOIN mst_position p ON e.position_id = p.position_id
      LEFT JOIN mst_department d ON e.department_id = d.department_id
      LEFT JOIN mst_company c ON e.company_id = c.company_id
      ${whereClause}
      ORDER BY e.full_name ASC`,
      params
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getTodayTeamMood] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /know-your-employee/mood/summary — ringkasan / statistik mood (chart)
// Query params: year, month, company_id
// ═══════════════════════════════════════════════════════════════════════════
export const getMoodSummary = async (req, res) => {
  try {
    const now = new Date();
    const {
      year = now.getFullYear(),
      month = now.getMonth() + 1,
      company_id = "",
    } = req.query;

    const conditions = [
      "YEAR(tm.mood_date) = ?",
      "MONTH(tm.mood_date) = ?",
    ];
    const params = [Number(year), Number(month)];

    if (company_id) {
      conditions.push("e.company_id = ?");
      params.push(company_id);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    // Breakdown per mood_level
    const [byMood] = await safeQuery(
      `SELECT mood_level, COUNT(*) AS total
       FROM tr_employee_mood tm
       JOIN mst_employee e ON tm.employee_id = e.employee_id
       ${whereClause}
       GROUP BY mood_level
       ORDER BY total DESC`,
      params
    );

    // Tren harian dalam bulan tersebut
    const [dailyTrend] = await safeQuery(
      `SELECT
         DAY(tm.mood_date) AS day,
         mood_level,
         COUNT(*) AS total
       FROM tr_employee_mood tm
       JOIN mst_employee e ON tm.employee_id = e.employee_id
       ${whereClause}
       GROUP BY DAY(tm.mood_date), mood_level
       ORDER BY day ASC`,
      params
    );

    // Total karyawan yang sudah isi hari ini
    const [[{ filled_today }]] = await safeQuery(
      `SELECT COUNT(DISTINCT tm.employee_id) AS filled_today
       FROM tr_employee_mood tm
       JOIN mst_employee e ON tm.employee_id = e.employee_id
       WHERE tm.mood_date = CURDATE()
       ${company_id ? "AND e.company_id = ?" : ""}`,
      company_id ? [company_id] : []
    );

    // Total karyawan aktif (is_deleted = 0)
    const [[{ total_active }]] = await safeQuery(
      `SELECT COUNT(*) AS total_active
       FROM mst_employee
       WHERE is_deleted = 0
       ${company_id ? "AND company_id = ?" : ""}`,
      company_id ? [company_id] : []
    );

    return res.json({
      success: true,
      data: {
        period: { year: Number(year), month: Number(month) },
        by_mood: byMood,
        daily_trend: dailyTrend,
        today_stats: {
          filled: Number(filled_today),
          total_active: Number(total_active),
          not_filled: Number(total_active) - Number(filled_today),
        },
      },
    });
  } catch (err) {
    console.error("[getMoodSummary] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /know-your-employee/mood/:employeeId — riwayat mood 1 karyawan
// ═══════════════════════════════════════════════════════════════════════════
export const getEmployeeMoodHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { limit = 30 } = req.query;

    const [rows] = await safeQuery(
      `SELECT
         tm.id,
         tm.mood_level,
         tm.mood_date,
         tm.created_at,
         e.full_name,
         e.employee_code
       FROM tr_employee_mood tm
       JOIN mst_employee e ON tm.employee_id = e.employee_id
       WHERE tm.employee_id = ?
       ORDER BY tm.mood_date DESC
       LIMIT ?`,
      [Number(employeeId), Number(limit)]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getEmployeeMoodHistory] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};