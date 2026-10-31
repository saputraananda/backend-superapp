// src/controllers/csatNpsController.js
import { safeQuery, safeMyWaschenQuery } from "../db/pool.js";

// ─── Helper: table name by brand ─────────────────────────────────────────────
function getTable(brand) {
  if (brand === "cleanox") return "tr_customer_satisfaction_cleanox";
  return "tr_customer_satisfaction_waschen";
}

// ─── Helper: cabang & customer dari transaksi My Waschen (khusus Waschen) ────
// no_nota di survei hanya 6 digit terakhir order_no, jadi bisa kembar antar
// transaksi/cabang. Survei diisi setelah nota dibuat, maka dipilih transaksi
// terbaru yang order_date-nya <= waktu survei.
async function attachWaschenOutlet(rows) {
  const keys = [...new Set(
    rows.map((r) => String(r.no_nota || "").trim().slice(-6)).filter((k) => /^\d{6}$/.test(k))
  )];
  const byKey = new Map();
  if (keys.length) {
    const [trx] = await safeMyWaschenQuery(
      `SELECT RIGHT(t.order_no, 6) AS nota6, t.order_date, t.outlet_id,
              o.name AS outlet_name, c.name AS customer_name
       FROM tr_transaction t
       LEFT JOIN mst_outlet o ON o.id = t.outlet_id
       LEFT JOIN mst_customer c ON c.id = t.customer_id
       WHERE RIGHT(t.order_no, 6) IN (?)`,
      [keys]
    );
    for (const t of trx) {
      if (!byKey.has(t.nota6)) byKey.set(t.nota6, []);
      byKey.get(t.nota6).push(t);
    }
  }
  return rows.map((r) => {
    const surveyAt = new Date(r.created_at).getTime();
    const best = (byKey.get(String(r.no_nota || "").trim().slice(-6)) || [])
      .filter((t) => new Date(t.order_date).getTime() <= surveyAt)
      .sort((a, b) => new Date(b.order_date) - new Date(a.order_date))[0];
    return {
      ...r,
      outlet_id: best?.outlet_id ?? null,
      outlet_name: best?.outlet_name ?? null,
      customer_name: best?.customer_name ?? null,
    };
  });
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
    // ── Cabang (Waschen): agregat per cabang + filter outlet_id untuk seluruh statistik ──
    let byOutlet = [];
    let idSql = ""; // potongan " AND id IN (...)" untuk query lain
    if (brand === "waschen") {
      const [base] = await safeQuery(
        `SELECT id, no_nota, created_at, csat_score, nps_score, nps_category
         FROM ${table} ${dateFilter.length ? `WHERE ${dateFilter.join(" AND ")}` : ""}`,
        dateParams
      );
      const resolved = await attachWaschenOutlet(base);

      const groups = new Map();
      for (const r of resolved) {
        const key = r.outlet_id ?? "none";
        if (!groups.has(key)) {
          groups.set(key, { outlet_id: r.outlet_id, outlet_name: r.outlet_name || "Tidak terdeteksi",
            total: 0, csat_sum: 0, promoters: 0, passives: 0, detractors: 0 });
        }
        const g = groups.get(key);
        g.total += 1;
        g.csat_sum += Number(r.csat_score) || 0;
        if (r.nps_category === "Promoter") g.promoters += 1;
        else if (r.nps_category === "Passive") g.passives += 1;
        else if (r.nps_category === "Detractor") g.detractors += 1;
      }
      byOutlet = [...groups.values()]
        .map(({ csat_sum, ...g }) => ({
          ...g,
          avg_csat: g.total ? Math.round((csat_sum / g.total) * 100) / 100 : 0,
          nps_score: g.total ? Math.round(((g.promoters - g.detractors) / g.total) * 100) : 0,
        }))
        .sort((a, b) => b.total - a.total);

      const outletFilter = Number(req.query.outlet_id);
      if (Number.isFinite(outletFilter) && outletFilter > 0) {
        const ids = resolved.filter((r) => Number(r.outlet_id) === outletFilter).map((r) => Number(r.id));
        const idList = ids.length ? ids.join(",") : "0";
        dateFilter.push(`id IN (${idList})`);
        idSql = ` AND id IN (${idList})`;
      }
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
       WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)${idSql}
       GROUP BY DATE_FORMAT(created_at, '%Y-%m')
       ORDER BY month ASC`
    );

    // ── 7. Recent feedback texts ──
    const namaCol = brand === "cleanox" ? ", nama" : "";
    const layananCol = ", layanan";
    const [recentFeedback] = await safeQuery(
      `SELECT id, no_nota${namaCol}${layananCol}, csat_score, csat_label, nps_score, nps_category,
              feedback_tags, feedback_text, created_at
       FROM ${table}
       WHERE feedback_text IS NOT NULL AND feedback_text != ''${idSql}
       ORDER BY created_at DESC
       LIMIT 10`,
      []
    );

    // ── 8. Recent responses (latest 20) ──
    const [recentResponses] = await safeQuery(
      `SELECT id, no_nota${namaCol}${layananCol}, csat_score, csat_label, nps_score, nps_category,
              feedback_tags, created_at
       FROM ${table}
       ${idSql ? `WHERE 1=1${idSql}` : ""}
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
         WHERE layanan IS NOT NULL AND layanan != ''${idSql}
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

    let outlets = [];
    let recentFeedbackOut = recentFeedback;
    let recentResponsesOut = recentResponses;
    if (brand === "waschen") {
      [recentFeedbackOut, recentResponsesOut] = await Promise.all([
        attachWaschenOutlet(recentFeedback),
        attachWaschenOutlet(recentResponses),
      ]);
      const [outletRows] = await safeMyWaschenQuery("SELECT id, name FROM mst_outlet ORDER BY id");
      outlets = outletRows;
    }

    res.json({
      data: {
        outlets,
        by_outlet: byOutlet,
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
        recent_feedback: recentFeedbackOut,
        recent_responses: recentResponsesOut,
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

    // Filter cabang (Waschen): cabang berasal dari transaksi di database lain,
    // jadi ambil semua baris yang lolos filter lain, resolve cabang, lalu paginasi manual.
    const outletFilter = brand === "waschen" ? Number(req.query.outlet_id) : NaN;
    if (Number.isFinite(outletFilter) && outletFilter > 0) {
      const [all] = await safeQuery(
        `SELECT * FROM ${table} ${whereSql} ORDER BY created_at DESC`,
        params
      );
      const matched = (await attachWaschenOutlet(all)).filter((r) => Number(r.outlet_id) === outletFilter);
      return res.json({
        data: matched.slice(offset, offset + lm),
        pagination: { page: pg, limit: lm, total: matched.length, totalPages: Math.ceil(matched.length / lm) },
      });
    }

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
      data: brand === "waschen" ? await attachWaschenOutlet(rows) : rows,
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
    const {
      no_nota,
      nama,
      csat_score,
      csat_label,
      nps_score,
      nps_category,
      feedback_tags,
      feedback_text,
      layanan,
    } = req.body;

    if (!csat_score || !csat_label || nps_score === undefined || !nps_category) {
      return res.status(400).json({ message: "Field wajib tidak lengkap" });
    }

    const ip = req.ip || req.connection?.remoteAddress || null;
    const ua = req.headers["user-agent"] || null;
    const nota = String(no_nota || "").trim();
    const layananValue = layanan === undefined || layanan === null ? null : String(layanan).trim() || null;

    if (brand === "cleanox") {
      // Replace-by-nota when no_nota provided (one row per transaction_no / no_nota).
      if (nota) {
        const [existing] = await safeQuery(
          `SELECT id, layanan FROM ${table} WHERE TRIM(no_nota) = ? ORDER BY id ASC`,
          [nota]
        );
        const keepId = existing.length > 0 ? Number(existing[0].id) : null;
        const extraIds = existing.slice(1).map((row) => Number(row.id)).filter(Boolean);
        const nextLayanan =
          layanan !== undefined && layanan !== null
            ? layananValue
            : keepId
              ? existing[0].layanan ?? null
              : null;

        if (keepId) {
          await safeQuery(
            `UPDATE ${table}
             SET no_nota = ?,
                 nama = ?,
                 csat_score = ?,
                 csat_label = ?,
                 nps_score = ?,
                 nps_category = ?,
                 feedback_tags = ?,
                 feedback_text = ?,
                 layanan = ?,
                 ip_address = ?,
                 user_agent = ?
             WHERE id = ?`,
            [
              nota,
              nama || null,
              Number(csat_score),
              csat_label,
              Number(nps_score),
              nps_category,
              feedback_tags || null,
              feedback_text || null,
              nextLayanan,
              ip,
              ua,
              keepId,
            ]
          );
          if (extraIds.length > 0) {
            await safeQuery(`DELETE FROM ${table} WHERE id IN (?)`, [extraIds]);
          }
          return res.status(201).json({ message: "Survey berhasil disimpan", id: keepId, replaced: true });
        }

        const [result] = await safeQuery(
          `INSERT INTO ${table}
             (no_nota, nama, csat_score, csat_label, nps_score, nps_category,
              feedback_tags, feedback_text, layanan, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            nota,
            nama || null,
            Number(csat_score),
            csat_label,
            Number(nps_score),
            nps_category,
            feedback_tags || null,
            feedback_text || null,
            nextLayanan,
            ip,
            ua,
          ]
        );
        return res.status(201).json({ message: "Survey berhasil disimpan", id: result.insertId });
      }

      const [result] = await safeQuery(
        `INSERT INTO ${table}
           (no_nota, nama, csat_score, csat_label, nps_score, nps_category,
            feedback_tags, feedback_text, layanan, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          null,
          nama || null,
          Number(csat_score),
          csat_label,
          Number(nps_score),
          nps_category,
          feedback_tags || null,
          feedback_text || null,
          layananValue,
          ip,
          ua,
        ]
      );
      return res.status(201).json({ message: "Survey berhasil disimpan", id: result.insertId });
    }

    // Waschen — no `nama` column, `layanan` optional (Satuan/Kiloan)
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
