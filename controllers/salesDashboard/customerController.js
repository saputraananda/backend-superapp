import { safeSmartlinkQuery } from "../../db/pool.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function buildOutletClause(outlet, alias = "outlet") {
  if (!outlet || outlet.length === 0 || outlet.includes("all")) return { clause: "", params: [] };
  const clause = `AND LOWER(${alias}) IN (${outlet.map(() => "?").join(",")})`;
  const params = outlet.map(o => String(o).toLowerCase());
  return { clause, params };
}

const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE  = /^\d{4}$/;

function buildDateClause(filterType, month, year, startDate, endDate) {
  if (filterType === "range" && startDate && endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate)) {
    return {
      clause: "AND terdaftar_sejak >= ? AND terdaftar_sejak < DATE_ADD(?, INTERVAL 1 DAY)",
      params: [startDate, endDate],
    };
  }
  if (filterType === "month" && month && MONTH_RE.test(month)) {
    const [y, m] = month.split("-");
    return {
      clause: "AND YEAR(terdaftar_sejak) = ? AND MONTH(terdaftar_sejak) = ?",
      params: [y, m],
    };
  }
  if (filterType === "year" && year && YEAR_RE.test(year)) {
    return {
      clause: "AND YEAR(terdaftar_sejak) = ?",
      params: [year],
    };
  }
  return { clause: "", params: [] };
}

const OUTLET_CASE = `
  CASE
    WHEN outlet LIKE '%Raffles Hills%'   THEN 'Raffles Hills'
    WHEN outlet LIKE '%Legenda Wisata%'  THEN 'Legenda Wisata'
    WHEN outlet LIKE '%Canadian%'        THEN 'Canadian'
    WHEN outlet LIKE '%Kota Wisata%'     THEN 'Kota Wisata'
    WHEN outlet LIKE '%Citra Grand%'     THEN 'Citra Grand'
    ELSE COALESCE(NULLIF(TRIM(outlet), ''), 'Tidak Diketahui')
  END`;

// ─── controller ─────────────────────────────────────────────────────────────

export const getCustomer = async (req, res) => {
  try {
    let outlet = req.query.outlet;
    if (!outlet) { outlet = ["all"]; }
    else if (typeof outlet === "string") { outlet = [outlet]; }

    const { filterType, month, year, startDate, endDate } = req.query;

    const { clause: outletClause, params: outletParams } = buildOutletClause(outlet);
    const { clause: dateClause,  params: dateParams  } = buildDateClause(filterType, month, year, startDate, endDate);

    // base WHERE
    const baseWhere  = `WHERE nama NOT LIKE '%dummy%' ${outletClause} ${dateClause}`;
    const baseParams = [...outletParams, ...dateParams];

    // Build daily-trend query based on filter type
    let dailyTrendSql, dailyTrendParams;
    const { clause: oCDaily, params: oPDaily } = buildOutletClause(outlet, "outlet");
    if (filterType === "year" && year && YEAR_RE.test(year)) {
      dailyTrendSql = `
        SELECT DATE_FORMAT(terdaftar_sejak, '%Y-%m') AS day, COUNT(*) AS count
        FROM customer
        WHERE nama NOT LIKE '%dummy%' AND YEAR(terdaftar_sejak) = ? ${oCDaily}
        GROUP BY day ORDER BY day ASC
      `;
      dailyTrendParams = [year, ...oPDaily];
    } else if (dateClause) {
      dailyTrendSql = `
        SELECT DATE(terdaftar_sejak) AS day, COUNT(*) AS count
        FROM customer
        WHERE nama NOT LIKE '%dummy%' ${oCDaily} ${dateClause}
        GROUP BY day ORDER BY day ASC
      `;
      dailyTrendParams = [...oPDaily, ...dateParams];
    } else {
      dailyTrendSql = `
        SELECT DATE(terdaftar_sejak) AS day, COUNT(*) AS count
        FROM customer
        WHERE nama NOT LIKE '%dummy%' ${oCDaily}
          AND terdaftar_sejak >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        GROUP BY day ORDER BY day ASC
      `;
      dailyTrendParams = [...oPDaily];
    }

    // Run all queries in parallel
    const [
      [kpiRows],
      [outletRows],
      [genderRows],
      [dailyTrendRows],
      [trendRows],
      [topRows],
      [activityRows],
    ] = await Promise.all([

      // 1. KPI summary
      safeSmartlinkQuery(`
        SELECT
          COUNT(*)                                                              AS total,
          SUM(CASE WHEN total_jumlah_transaksi > 4            THEN 1 ELSE 0 END) AS loyal,
          SUM(CASE WHEN total_jumlah_transaksi BETWEEN 2 AND 3 THEN 1 ELSE 0 END) AS regular,
          SUM(CASE WHEN total_jumlah_transaksi = 1             THEN 1 ELSE 0 END) AS one_time,
          SUM(CASE WHEN total_jumlah_transaksi = 0             THEN 1 ELSE 0 END) AS inactive,
          COALESCE(SUM(saldo_epayment),        0)                               AS total_saldo_epayment,
          ROUND(AVG(total_jumlah_transaksi),   1)                               AS avg_transaksi,
          COALESCE(SUM(total_nominal_transaksi), 0)                             AS total_omzet
        FROM customer
        ${baseWhere}
      `, baseParams),

      // 2. Segmentation per outlet
      safeSmartlinkQuery(`
        SELECT
          ${OUTLET_CASE} AS outlet_name,
          COUNT(*) AS total,
          SUM(CASE WHEN total_jumlah_transaksi > 4             THEN 1 ELSE 0 END) AS loyal,
          SUM(CASE WHEN total_jumlah_transaksi BETWEEN 2 AND 3  THEN 1 ELSE 0 END) AS regular,
          SUM(CASE WHEN total_jumlah_transaksi = 1              THEN 1 ELSE 0 END) AS one_time,
          SUM(CASE WHEN total_jumlah_transaksi = 0              THEN 1 ELSE 0 END) AS inactive
        FROM customer
        WHERE nama NOT LIKE '%dummy%' ${dateClause}
        GROUP BY outlet_name
        ORDER BY total DESC
      `, [...dateParams]),

      // 3. Gender distribution
      safeSmartlinkQuery(`
        SELECT
          COALESCE(NULLIF(TRIM(jenis_kelamin), ''), 'Tidak Diketahui') AS jenis_kelamin,
          COUNT(*) AS count
        FROM customer
        ${baseWhere}
        GROUP BY jenis_kelamin
        ORDER BY count DESC
      `, baseParams),

      // 4. Daily registration trend
      safeSmartlinkQuery(dailyTrendSql, dailyTrendParams),

      // 5. Registration trend — always last 12 months (ignore date filter)
      safeSmartlinkQuery(`
        SELECT
          DATE_FORMAT(terdaftar_sejak, '%Y-%m') AS month,
          COUNT(*) AS count
        FROM customer
        WHERE nama NOT LIKE '%dummy%'
          AND terdaftar_sejak >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
          ${oCDaily}
        GROUP BY month
        ORDER BY month ASC
      `, [...oPDaily]),

      // 6. Top 50 customers
      safeSmartlinkQuery(`
        SELECT
          TRIM(nama)                                      AS nama,
          COALESCE(NULLIF(TRIM(nomor_telpon), ''), '-')   AS nomor_telpon,
          COALESCE(NULLIF(TRIM(instansi), ''), '-')       AS instansi,
          ${OUTLET_CASE}                                  AS outlet,
          total_jumlah_transaksi,
          total_nominal_transaksi,
          saldo_epayment,
          sisa_nominal,
          transaksi_terakhir,
          terdaftar_sejak,
          masa_aktif,
          COALESCE(NULLIF(TRIM(member), ''), '-')         AS member
        FROM customer
        ${baseWhere}
          AND total_jumlah_transaksi > 0
        ORDER BY total_nominal_transaksi DESC, total_jumlah_transaksi DESC
        LIMIT 50
      `, baseParams),

      // 7. Activity breakdown — not filtered by date
      safeSmartlinkQuery(`
        SELECT
          SUM(CASE WHEN transaksi_terakhir >= DATE_SUB(NOW(), INTERVAL 30 DAY)  THEN 1 ELSE 0 END) AS active_30d,
          SUM(CASE WHEN transaksi_terakhir >= DATE_SUB(NOW(), INTERVAL 90 DAY)
                    AND transaksi_terakhir <  DATE_SUB(NOW(), INTERVAL 30 DAY)  THEN 1 ELSE 0 END) AS active_90d,
          SUM(CASE WHEN transaksi_terakhir <  DATE_SUB(NOW(), INTERVAL 90 DAY)
                    OR  transaksi_terakhir IS NULL                              THEN 1 ELSE 0 END) AS churned
        FROM customer
        WHERE nama NOT LIKE '%dummy%' ${oCDaily}
      `, [...oPDaily]),
    ]);

    const kpi      = kpiRows[0]      ?? {};
    const activity = activityRows[0] ?? {};

    res.json({
      kpi: {
        total:                Number(kpi.total)                || 0,
        loyal:                Number(kpi.loyal)                || 0,
        regular:              Number(kpi.regular)              || 0,
        one_time:             Number(kpi.one_time)             || 0,
        inactive:             Number(kpi.inactive)             || 0,
        total_saldo_epayment: Number(kpi.total_saldo_epayment) || 0,
        avg_transaksi:        Number(kpi.avg_transaksi)        || 0,
        total_omzet:          Number(kpi.total_omzet)          || 0,
      },
      per_outlet:         outletRows,
      gender:             genderRows,
      daily_trend:        dailyTrendRows,
      registration_trend: trendRows,
      top_customers:      topRows,
      activity: {
        active_30d: Number(activity.active_30d) || 0,
        active_90d: Number(activity.active_90d) || 0,
        churned:    Number(activity.churned)    || 0,
      },
    });
  } catch (err) {
    console.error("[customerController.getCustomer]", err);
    res.status(500).json({ message: err.message });
  }
};
