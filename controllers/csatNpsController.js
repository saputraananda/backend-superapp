// src/controllers/csatNpsController.js
import { safeQuery } from "../db/pool.js";

// ─── Helper: table name by brand ─────────────────────────────────────────────
function getTable(brand) {
  if (brand === "cleanox") return "tr_customer_satisfaction_cleanox";
  return "tr_customer_satisfaction_waschen";
}

// ─── GET /stats/:brand  — Dashboard aggregated stats ─────────────────────────
export const getStats = async (req, res) => {
  try {
    const { brand } = req.params;
    if (!["waschen", "cleanox"].includes(brand)) {
      return res.status(400).json({ message: "Brand tidak valid. Gunakan 'waschen' atau 'cleanox'." });
    }

    const table = getTable(brand);
    const { startDate, endDate } = req.query;

    const dateFilter = [];
    const dateParams = [];
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      dateFilter.push("created_at >= ?");
      dateParams.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      dateFilter.push("created_at <= ?");
      dateParams.push(endDate + " 23:59:59");
    }
    const whereSql = dateFilter.length ? `WHERE ${dateFilter.join(" AND ")}` : "";

    // ── 1. Overall summary ──
    const [[summary]] = await safeQuery(
      `SELECT
         COUNT(*) AS total_responses,
         ROUND(AVG(csat_score), 2) AS avg_csat,
         ROUND(AVG(nps_score), 2) AS avg_nps,
         SUM(CASE WHEN nps_category = 'Promoter' THEN 1 ELSE 0 END) AS promoters,
         SUM(CASE WHEN nps_category = 'Passive' THEN 1 ELSE 0 END) AS passives,
         SUM(CASE WHEN nps_category = 'Detractor' THEN 1 ELSE 0 END) AS detractors
       FROM ${table} ${whereSql}`,
      dateParams
    );

    // NPS Score = %Promoters - %Detractors (scale -100 to +100)
    const total = summary.total_responses || 0;
    const npsScore = total > 0
      ? Math.round(((summary.promoters / total) - (summary.detractors / total)) * 100)
      : 0;

    // ── 2. CSAT distribution (1-5) ──
    const [csatDist] = await safeQuery(
      `SELECT csat_score, COUNT(*) AS count
       FROM ${table} ${whereSql}
       GROUP BY csat_score
       ORDER BY csat_score ASC`,
      dateParams
    );

    // ── 3. NPS score distribution (0-10) ──
    const [npsDist] = await safeQuery(
      `SELECT nps_score, COUNT(*) AS count
       FROM ${table} ${whereSql}
       GROUP BY nps_score
       ORDER BY nps_score ASC`,
      dateParams
    );

    // ── 4. CSAT label breakdown ──
    const [csatLabels] = await safeQuery(
      `SELECT csat_label, COUNT(*) AS count
       FROM ${table} ${whereSql}
       GROUP BY csat_label
       ORDER BY count DESC`,
      dateParams
    );

    // ── 5. Feedback tags breakdown ──
    const tagWhere = dateFilter.length
      ? `WHERE ${dateFilter.join(" AND ")} AND feedback_tags IS NOT NULL AND feedback_tags != ''`
      : `WHERE feedback_tags IS NOT NULL AND feedback_tags != ''`;
    const [tagRows] = await safeQuery(
      `SELECT feedback_tags FROM ${table} ${tagWhere}`,
      dateParams
    );
    const tagCounts = {};
    tagRows.forEach((row) => {
      if (row.feedback_tags) {
        row.feedback_tags.split(",").forEach((tag) => {
          const t = tag.trim();
          if (t) tagCounts[t] = (tagCounts[t] || 0) + 1;
        });
      }
    });
    const topTags = Object.entries(tagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    // ── 6. Monthly trend (last 12 months) ──
    const [trend] = await safeQuery(
      `SELECT
         DATE_FORMAT(created_at, '%Y-%m') AS month,
         COUNT(*) AS responses,
         ROUND(AVG(csat_score), 2) AS avg_csat,
         ROUND(AVG(nps_score), 2) AS avg_nps,
         SUM(CASE WHEN nps_category = 'Promoter' THEN 1 ELSE 0 END) AS promoters,
         SUM(CASE WHEN nps_category = 'Detractor' THEN 1 ELSE 0 END) AS detractors
       FROM ${table}
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month ASC`
    );

    // ── 7. Recent feedback texts ──
    const namaCol = brand === "cleanox" ? ", nama" : "";
    const [recentFeedback] = await safeQuery(
      `SELECT id, no_nota${namaCol}, layanan, csat_score, csat_label, nps_score, nps_category,
              feedback_tags, feedback_text, created_at
       FROM ${table}
       WHERE feedback_text IS NOT NULL AND feedback_text != ''
       ORDER BY created_at DESC
       LIMIT 10`,
      []
    );

    // ── 8. Recent responses (latest 20) ──
    const [recentResponses] = await safeQuery(
      `SELECT id, no_nota${namaCol}, layanan, csat_score, csat_label, nps_score, nps_category,
              feedback_tags, created_at
       FROM ${table}
       ORDER BY created_at DESC
       LIMIT 20`,
      []
    );

    // ── 9. CSAT by service (layanan) — split comma-separated values ──
    const [csatByService] = await safeQuery(
      `WITH RECURSIVE split AS (
         SELECT
           csat_score,
           TRIM(SUBSTRING_INDEX(layanan, ',', 1)) AS single_layanan,
           TRIM(SUBSTRING(layanan, LENGTH(SUBSTRING_INDEX(layanan, ',', 1)) + 2)) AS rest
         FROM ${table}
         WHERE layanan IS NOT NULL AND layanan != ''
         UNION ALL
         SELECT
           csat_score,
           TRIM(SUBSTRING_INDEX(rest, ',', 1)),
           TRIM(SUBSTRING(rest, LENGTH(SUBSTRING_INDEX(rest, ',', 1)) + 2))
         FROM split
         WHERE rest != ''
       )
       SELECT
         single_layanan AS layanan,
         COUNT(*) AS total,
         SUM(CASE WHEN csat_score = 5 THEN 1 ELSE 0 END) AS bintang_5,
         SUM(CASE WHEN csat_score = 4 THEN 1 ELSE 0 END) AS bintang_4,
         SUM(CASE WHEN csat_score = 3 THEN 1 ELSE 0 END) AS bintang_3,
         SUM(CASE WHEN csat_score = 2 THEN 1 ELSE 0 END) AS bintang_2,
         SUM(CASE WHEN csat_score = 1 THEN 1 ELSE 0 END) AS bintang_1
       FROM split
       GROUP BY single_layanan
       ORDER BY total DESC`,
      []
    );

    res.json({
      data: {
        summary: {
          total_responses: total,
          avg_csat: summary.avg_csat || 0,
          avg_nps: summary.avg_nps || 0,
          nps_score: npsScore,
          promoters: summary.promoters || 0,
          passives: summary.passives || 0,
          detractors: summary.detractors || 0,
        },
        csat_distribution: csatDist,
        nps_distribution: npsDist,
        csat_labels: csatLabels,
        top_tags: topTags,
        monthly_trend: trend,
        recent_feedback: recentFeedback,
        recent_responses: recentResponses,
        csat_by_service: csatByService,
      },
    });
  } catch (err) {
    console.error("getStats:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /:brand  — list responses with pagination & filters ─────────────────
export const getResponses = async (req, res) => {
  try {
    const { brand } = req.params;
    if (!["waschen", "cleanox"].includes(brand)) {
      return res.status(400).json({ message: "Brand tidak valid." });
    }

    const table = getTable(brand);
    const { page = 1, limit = 25, search, nps_category, csat_score, layanan, startDate, endDate } = req.query;
    const pg = Math.max(1, Number(page) || 1);
    const lm = Math.min(Math.max(1, Number(limit) || 25), 200);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      if (brand === "cleanox") {
        where.push("(no_nota LIKE ? OR nama LIKE ? OR feedback_text LIKE ? OR feedback_tags LIKE ?)");
        params.push(like, like, like, like);
      } else {
        where.push("(no_nota LIKE ? OR feedback_text LIKE ? OR feedback_tags LIKE ?)");
        params.push(like, like, like);
      }
    }
    if (nps_category && ["Detractor", "Passive", "Promoter"].includes(nps_category)) {
      where.push("nps_category = ?");
      params.push(nps_category);
    }
    if (csat_score && [1, 2, 3, 4, 5].includes(Number(csat_score))) {
      where.push("csat_score = ?");
      params.push(Number(csat_score));
    }
    if (layanan?.trim()) {
      where.push("layanan LIKE ?");
      params.push(`%${layanan.trim()}%`);
    }
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      where.push("created_at >= ?");
      params.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      where.push("created_at <= ?");
      params.push(endDate + " 23:59:59");
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeQuery(
      `SELECT COUNT(*) AS total FROM ${table} ${whereSql}`,
      params
    );

    const [rows] = await safeQuery(
      `SELECT * FROM ${table} ${whereSql}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    res.json({
      data: rows,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
    });
  } catch (err) {
    console.error("getResponses:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── POST /:brand  — create response (public survey submission) ─────────────
export const createResponse = async (req, res) => {
  try {
    const { brand } = req.params;
    if (!["waschen", "cleanox"].includes(brand)) {
      return res.status(400).json({ message: "Brand tidak valid." });
    }

    const table = getTable(brand);
    const { no_nota, nama, csat_score, csat_label, nps_score, nps_category, feedback_tags, feedback_text } = req.body;

    if (!csat_score || !csat_label || nps_score === undefined || !nps_category) {
      return res.status(400).json({ message: "Field wajib tidak lengkap" });
    }

    const ip = req.ip || req.connection?.remoteAddress || null;
    const ua = req.headers["user-agent"] || null;

    if (brand === "cleanox") {
      const [result] = await safeQuery(
        `INSERT INTO ${table}
           (no_nota, nama, csat_score, csat_label, nps_score, nps_category, feedback_tags, feedback_text, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [no_nota || null, nama || null, Number(csat_score), csat_label, Number(nps_score), nps_category, feedback_tags || null, feedback_text || null, ip, ua]
      );
      return res.status(201).json({ message: "Survey berhasil disimpan", id: result.insertId });
    }

    // Waschen — no `nama` column
    const [result] = await safeQuery(
      `INSERT INTO ${table}
         (no_nota, csat_score, csat_label, nps_score, nps_category, feedback_tags, feedback_text, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [no_nota || null, Number(csat_score), csat_label, Number(nps_score), nps_category, feedback_tags || null, feedback_text || null, ip, ua]
    );

    res.status(201).json({ message: "Survey berhasil disimpan", id: result.insertId });
  } catch (err) {
    console.error("createResponse:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── PATCH /:brand/:id  — update layanan ─────────────────────────────────────
export const updateLayanan = async (req, res) => {
  try {
    const { brand, id } = req.params;
    if (!["waschen", "cleanox"].includes(brand)) {
      return res.status(400).json({ message: "Brand tidak valid." });
    }
    const { layanan } = req.body;
    if (layanan === undefined) {
      return res.status(400).json({ message: "Field 'layanan' wajib diisi." });
    }

    const table = getTable(brand);
    const [[existing]] = await safeQuery(`SELECT id FROM ${table} WHERE id = ?`, [Number(id)]);
    if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

    await safeQuery(`UPDATE ${table} SET layanan = ? WHERE id = ?`, [layanan, Number(id)]);
    res.json({ message: "Layanan berhasil diperbarui" });
  } catch (err) {
    console.error("updateLayanan:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── DELETE /:brand/:id ──────────────────────────────────────────────────────
export const deleteResponse = async (req, res) => {
  try {
    const { brand, id } = req.params;
    if (!["waschen", "cleanox"].includes(brand)) {
      return res.status(400).json({ message: "Brand tidak valid." });
    }

    const table = getTable(brand);
    const [[existing]] = await safeQuery(`SELECT id FROM ${table} WHERE id = ?`, [Number(id)]);
    if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

    await safeQuery(`DELETE FROM ${table} WHERE id = ?`, [Number(id)]);
    res.json({ message: "Data berhasil dihapus" });
  } catch (err) {
    console.error("deleteResponse:", err);
    res.status(500).json({ message: err.message });
  }
};
