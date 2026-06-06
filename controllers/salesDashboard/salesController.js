import { safeSmartlinkQuery } from "../../db/pool.js";

const EXCLUDED_NOTAS = [
  'JDS250308134809893','JRC250412083723856','LKZ250422142258203','QSE250429084550314','POS250430090223407',
  'MDR250430160351857','TSI250501092607556','YOX250501094449877','PWX250501094618850','CAY250501162309243',
  'AIR250502165019925','VYO250504101231388','BPZ250505153114890','YNZ250506084550029','LPA250509104354921',
  'JKM250509133602454','ATR250509155731919','UVN250509155937609','COZ250510085855458','KCE250510092127311',
  'PPR250511104248281','ULX250511141125683','CPD250511150921365','MSB250512102328567','YSS250512142214977',
  'ESY250514094634398','VOE250514104206010','NPA250514134849617','KIZ250514150134296','RJR250514150240950',
  'VBJ250521105035645','WSL250612090231990','XND250612090410209','ESZ250622092835859','VRB250705145607387',
  'WNP250707092257535','ZQN250707095003871','ZQG250723150341368','SNR250726152557061','ZTZ250819164141353',
  'MLL250911095440273','OXI250916160645735','TYO250919133458354','OSD250919135615402','QGC250927143951995',
  'FGH251010145932475','EYF251013085108373','VPA251015090406450','LIZ251019134650581','DOT251027093136503',
  'ORC251027100046038','KZZ251119154110977',
];

// Compute billing period (26th–25th) from a reference date
function computeDateRange(asOfDate) {
  const d = new Date(asOfDate + "T12:00:00");
  const day = d.getDate();
  let dateStart, dateEnd;
  if (day >= 26) {
    dateStart = new Date(d.getFullYear(), d.getMonth(), 26);
    dateEnd   = new Date(d.getFullYear(), d.getMonth() + 1, 25);
  } else {
    dateStart = new Date(d.getFullYear(), d.getMonth() - 1, 26);
    dateEnd   = new Date(d.getFullYear(), d.getMonth(), 25);
  }
  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  return { dateStart: fmt(dateStart), dateEnd: fmt(dateEnd) };
}

// Helper: build IN clause and params for multi-outlet filtering
function buildOutletFilter(outlets) {
  if (!outlets || outlets.length === 0) {
    return { clause: "1=1", params: [] };
  }
  const placeholders = outlets.map(() => "?").join(",");
  return {
    clause: `LOWER(outlet) IN (${outlets.map(o => "LOWER(?)").join(",")})`,
    params: [...outlets, ...outlets],
  };
}

// Build IN clause for target_period
function buildTargetOutletFilter(outlets) {
  if (!outlets || outlets.length === 0) {
    return { clause: "1=1", params: [] };
  }
  return {
    clause: outlets.map(() => "?").join(","),
    params: outlets,
  };
}

export const getPenjualan = async (req, res) => {
  try {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let { asOfDate, startDate, endDate, outlets } = req.query;

    // Support outlets as array (from query string: ?outlets=x&outlets=y)
    if (typeof outlets === "string") {
      outlets = outlets.split(",").map(o => o.trim()).filter(Boolean);
    }
    if (!Array.isArray(outlets)) outlets = [];

    if (asOfDate   && !dateRe.test(asOfDate))   return res.status(400).json({ message: "Format asOfDate harus YYYY-MM-DD" });
    if (startDate  && !dateRe.test(startDate))  return res.status(400).json({ message: "Format startDate harus YYYY-MM-DD" });
    if (endDate    && !dateRe.test(endDate))     return res.status(400).json({ message: "Format endDate harus YYYY-MM-DD" });

    const isRange = !!(startDate && endDate);

    // Determine effective dates
    let effectiveAsOfDate, dateStart, dateEnd;
    if (isRange) {
      effectiveAsOfDate = endDate;
      dateStart = startDate;
      dateEnd   = endDate;
    } else {
      if (!asOfDate) {
        const y = new Date();
        y.setDate(y.getDate() - 1);
        const yy = y.getFullYear();
        const mm = String(y.getMonth() + 1).padStart(2, "0");
        const dd = String(y.getDate()).padStart(2, "0");
        asOfDate = `${yy}-${mm}-${dd}`;
      }
      effectiveAsOfDate = asOfDate;
      ({ dateStart, dateEnd } = computeDateRange(asOfDate));
    }

    // Cap effectiveAsOfDate to yesterday (today's data may be incomplete)
    // For past months this has no effect; for current month it shows proportional progress
    {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
      if (effectiveAsOfDate > yesterday) effectiveAsOfDate = yesterday;
      if (effectiveAsOfDate < dateStart) effectiveAsOfDate = dateStart;
    }

    const EP = EXCLUDED_NOTAS.map(() => "?").join(",");
    const hasOutletFilter = outlets.length > 0;

    // Build outlet filter clauses
    const regulerOutletFilter = buildOutletFilter(outlets);
    const emoneyOutletFilter = buildOutletFilter(outlets);
    const cleanoxOutletFilter = buildOutletFilter(outlets);
    const customerOutletFilter = buildOutletFilter(outlets);
    const targetOutletFilter = buildTargetOutletFilter(outlets);

    // ── Main per-outlet query ────────────────────────────────────────────
    const mainSql = `
WITH param AS (
    SELECT
        CURDATE() AS today,
        STR_TO_DATE(?, '%Y-%m-%d') AS as_of_date,
        STR_TO_DATE(?, '%Y-%m-%d') AS date_start,
        STR_TO_DATE(?, '%Y-%m-%d') AS date_end,
        STR_TO_DATE(?, '%Y-%m-%d') AS yesterday
),
reguler_daily AS (
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rtrp.waktu_pembayaran) AS tanggal,
           SUM(rtrp.nominal_bayar) AS total_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.as_of_date
    WHERE jenis_bayar <> 'e-money'
      AND no_nota NOT IN (${EP})
      AND (${hasOutletFilter ? regulerOutletFilter.clause : "1=1"})
      AND NOT EXISTS (
            SELECT 1 FROM rekap_transaksi_reguler rtr
            WHERE rtr.no_nota = rtrp.no_nota
              AND rtr.outlet LIKE '%legenda%'
              AND (rtr.nama_item LIKE '%haji%' OR rtr.customer_nama LIKE '%haji%')
      )
    GROUP BY outlet, tanggal
),
emoney_daily AS (
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rpe.tanggal_beli) AS tanggal,
           SUM(rpe.grand_total) AS total_saldo
    FROM rekap_pembelian_emoney rpe
    JOIN param p ON DATE(rpe.tanggal_beli) BETWEEN p.date_start AND p.as_of_date
    WHERE (${hasOutletFilter ? emoneyOutletFilter.clause : "1=1"})
    GROUP BY outlet, tanggal
),
combined_daily AS (
    SELECT outlet, tanggal, SUM(total) AS total_revenue
    FROM (
        SELECT outlet, tanggal, total_bayar AS total FROM reguler_daily
        UNION ALL
        SELECT outlet, tanggal, total_saldo AS total FROM emoney_daily
    ) x
    GROUP BY outlet, tanggal
),
actual AS (
    SELECT outlet, SUM(total_revenue) AS actual_sales FROM combined_daily GROUP BY outlet
),
actual_yesterday AS (
    SELECT cd.outlet, SUM(cd.total_revenue) AS actual_hari_ini
    FROM combined_daily cd
    JOIN param p ON cd.tanggal = p.as_of_date
    GROUP BY cd.outlet
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(
            CASE
                WHEN LOWER(COALESCE(rtr.nama_item, '')) LIKE '%cleanox%'
                  OR LOWER(COALESCE(rtr.nama_item, '')) LIKE '%karpet%'
                THEN 1 ELSE 0
            END
        ) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
cleanox_actual AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        SUM(rtrp.nominal_bayar) AS cleanox_sales
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.as_of_date
    JOIN nota_flag nf ON rtrp.no_nota COLLATE utf8mb4_unicode_ci = nf.no_nota
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND nf.is_cleanox = 1
      AND rtrp.no_nota NOT IN (${EP})
      AND (${hasOutletFilter ? cleanoxOutletFilter.clause : "1=1"})
      AND NOT EXISTS (
            SELECT 1 FROM rekap_transaksi_reguler rtr2
            WHERE rtr2.no_nota = rtrp.no_nota
              AND rtr2.outlet LIKE '%legenda%'
              AND (rtr2.nama_item LIKE '%haji%' OR rtr2.customer_nama LIKE '%haji%')
      )
    GROUP BY 1
),
customer_status AS (
    SELECT c.nama AS customer_nama,
           c.outlet COLLATE utf8mb4_unicode_ci AS outlet,
           CASE WHEN c.terdaftar_sejak >= p.date_start THEN 'Pelanggan Baru' ELSE 'Pelanggan Lama' END AS status_pelanggan
    FROM customer c
    CROSS JOIN param p
    WHERE c.nama NOT LIKE '%dumm%' AND c.nama NOT LIKE '%tes%'
      AND c.nama NOT LIKE '%haiyun%' AND c.nama NOT LIKE '%kiyalalala%'
      AND c.nama NOT LIKE '%puspaaa%' AND c.nama NOT LIKE '%haji%'
      AND (${hasOutletFilter ? customerOutletFilter.clause : "1=1"})
),
customer_activity AS (
    SELECT cs.customer_nama, cs.outlet, cs.status_pelanggan,
           COUNT(DISTINCT DATE(r.tgl_terima)) AS jumlah_hari_transaksi
    FROM customer_status cs
    JOIN rekap_transaksi_reguler r ON cs.customer_nama = r.customer_nama
    JOIN param p ON 1=1
    WHERE r.tgl_terima >= p.date_start
      AND r.tgl_terima < p.as_of_date + INTERVAL 1 DAY
      AND r.nama_item NOT LIKE '%haji%'
    GROUP BY cs.customer_nama, cs.outlet, cs.status_pelanggan
),
customer_segment AS (
    SELECT outlet, status_pelanggan,
           CASE WHEN jumlah_hari_transaksi >= 4 THEN 'Loyal'
                WHEN jumlah_hari_transaksi >= 2 THEN 'Regular'
                ELSE 'One Time' END AS segmentasi
    FROM customer_activity
),
customer_segment_counts AS (
    SELECT outlet,
           SUM(segmentasi='Loyal')              AS loyal_count,
           SUM(segmentasi='Regular')            AS regular_count,
           SUM(segmentasi='One Time')           AS one_time_count,
           SUM(status_pelanggan='Pelanggan Baru') AS new_customer_count
    FROM customer_segment
    GROUP BY outlet
),
target_period AS (
    SELECT ts.outlet, SUM(ts.nominal) AS nominal
    FROM target_sales ts
    CROSS JOIN param p
    WHERE (ts.tahun * 100 + ts.bulan) BETWEEN
          (YEAR(DATE_ADD(p.date_start, INTERVAL IF(DAY(p.date_start) >= 26, 1, 0) MONTH)) * 100
         + MONTH(DATE_ADD(p.date_start, INTERVAL IF(DAY(p.date_start) >= 26, 1, 0) MONTH)))
      AND
          (YEAR(DATE_ADD(p.date_end, INTERVAL IF(DAY(p.date_end) >= 26, 1, 0) MONTH)) * 100
         + MONTH(DATE_ADD(p.date_end, INTERVAL IF(DAY(p.date_end) >= 26, 1, 0) MONTH)))
      AND (${hasOutletFilter ? `ts.outlet IN (${targetOutletFilter.clause})` : "1=1"})
    GROUP BY ts.outlet
)
SELECT
    t.outlet,
    DATEDIFF(p.as_of_date, p.date_start)+1 AS date_count,
    DATEDIFF(p.date_end,   p.date_start)+1 AS total_day,
    ROUND(((DATEDIFF(p.as_of_date,p.date_start)+1)/(DATEDIFF(p.date_end,p.date_start)+1))*100,2) AS persen_target_kumulatif,
    ((DATEDIFF(p.as_of_date,p.date_start)+1)/(DATEDIFF(p.date_end,p.date_start)+1))*t.nominal     AS target_kumulatif_sales,
    t.nominal                                                                                       AS target_bulanan,
    COALESCE(a.actual_sales,0)                                                                      AS actual_sales,
    COALESCE(ay.actual_hari_ini,0)                                                                  AS actual_hari_ini,
    COALESCE(a.actual_sales,0) - (((DATEDIFF(p.as_of_date,p.date_start)+1)/(DATEDIFF(p.date_end,p.date_start)+1))*t.nominal) AS gap_nominal,
    ROUND((COALESCE(a.actual_sales,0)/NULLIF(t.nominal,0))*100,2)                                  AS persen_actual,
    ROUND(((COALESCE(a.actual_sales,0)/NULLIF(t.nominal,0))-((DATEDIFF(p.as_of_date,p.date_start)+1)/(DATEDIFF(p.date_end,p.date_start)+1)))*100,2) AS persen_gap,
    COALESCE(ca.cleanox_sales,0)       AS cleanox_sales,
    COALESCE(csc.loyal_count,0)        AS loyal_count,
    COALESCE(csc.regular_count,0)      AS regular_count,
    COALESCE(csc.one_time_count,0)     AS one_time_count,
    COALESCE(csc.new_customer_count,0) AS new_customer_count
FROM param p
CROSS JOIN target_period t
LEFT JOIN actual               a   ON a.outlet   COLLATE utf8mb4_unicode_ci = t.outlet COLLATE utf8mb4_unicode_ci
LEFT JOIN actual_yesterday     ay  ON ay.outlet  COLLATE utf8mb4_unicode_ci = t.outlet COLLATE utf8mb4_unicode_ci
LEFT JOIN cleanox_actual       ca  ON ca.outlet  COLLATE utf8mb4_unicode_ci = t.outlet COLLATE utf8mb4_unicode_ci
LEFT JOIN customer_segment_counts csc ON csc.outlet COLLATE utf8mb4_unicode_ci = t.outlet COLLATE utf8mb4_unicode_ci
WHERE (${hasOutletFilter ? `t.outlet IN (${targetOutletFilter.clause})` : "1=1"})
ORDER BY t.outlet`;

    // Build params for main query
    const mainParams = [
      effectiveAsOfDate, dateStart, dateEnd, effectiveAsOfDate, // param CTE
      ...EXCLUDED_NOTAS,                                         // NOT IN (reguler_daily)
      ...(hasOutletFilter ? regulerOutletFilter.params : []),  // reguler_daily outlet filter
      ...EXCLUDED_NOTAS,                                         // NOT IN (cleanox_actual)
      ...(hasOutletFilter ? cleanoxOutletFilter.params : []),  // cleanox_actual outlet filter
      ...(hasOutletFilter ? customerOutletFilter.params : []),  // customer_status outlet filter
      ...(hasOutletFilter ? targetOutletFilter.params : []),    // target_period outlet filter
      ...(hasOutletFilter ? targetOutletFilter.params : []),    // WHERE t.outlet
    ];

    // ── Daily trend query ────────────────────────────────────────────────
    const trendSql = `
SELECT
    DATE(tanggal) AS tanggal,
    SUM(total)    AS sales
FROM (
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rtrp.waktu_pembayaran) AS tanggal,
           SUM(rtrp.nominal_bayar)     AS total
    FROM rekap_transaksi_reguler_pembayaran rtrp
    WHERE DATE(rtrp.waktu_pembayaran) BETWEEN ? AND ?
      AND jenis_bayar <> 'e-money'
      AND no_nota NOT IN (${EP})
      AND (${hasOutletFilter ? regulerOutletFilter.clause : "1=1"})
      AND NOT EXISTS (
            SELECT 1 FROM rekap_transaksi_reguler rtr
            WHERE rtr.no_nota = rtrp.no_nota
              AND rtr.outlet LIKE '%legenda%'
              AND (rtr.nama_item LIKE '%haji%' OR rtr.customer_nama LIKE '%haji%')
      )
    GROUP BY outlet, tanggal
    UNION ALL
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rpe.tanggal_beli) AS tanggal,
           SUM(rpe.grand_total)   AS total
    FROM rekap_pembelian_emoney rpe
    WHERE DATE(rpe.tanggal_beli) BETWEEN ? AND ?
      AND (${hasOutletFilter ? emoneyOutletFilter.clause : "1=1"})
    GROUP BY outlet, tanggal
) x
GROUP BY tanggal
ORDER BY tanggal`;

    const trendParams = [
      dateStart, effectiveAsOfDate,  // reguler range
      ...EXCLUDED_NOTAS,
      ...(hasOutletFilter ? regulerOutletFilter.params : []),  // filter reguler
      dateStart, effectiveAsOfDate,  // emoney range
      ...(hasOutletFilter ? emoneyOutletFilter.params : []),   // filter emoney
    ];

    // ── Waschen-only trend (excludes cleanox notas) ──────────────────────
    const trendWaschenSql = `
SELECT
    DATE(tanggal) AS tanggal,
    SUM(total)    AS sales
FROM (
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rtrp.waktu_pembayaran) AS tanggal,
           SUM(rtrp.nominal_bayar)     AS total
    FROM rekap_transaksi_reguler_pembayaran rtrp
    LEFT JOIN (
        SELECT rtr2.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
               MAX(CASE
                   WHEN LOWER(COALESCE(rtr2.nama_item,'')) LIKE '%cleanox%'
                     OR LOWER(COALESCE(rtr2.nama_item,'')) LIKE '%karpet%'
                   THEN 1 ELSE 0 END) AS is_cleanox
        FROM rekap_transaksi_reguler rtr2
        GROUP BY rtr2.no_nota
    ) nf ON rtrp.no_nota COLLATE utf8mb4_unicode_ci = nf.no_nota
    WHERE DATE(rtrp.waktu_pembayaran) BETWEEN ? AND ?
      AND jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
      AND (${hasOutletFilter ? regulerOutletFilter.clause : "1=1"})
      AND COALESCE(nf.is_cleanox, 0) = 0
      AND NOT EXISTS (
            SELECT 1 FROM rekap_transaksi_reguler rtr
            WHERE rtr.no_nota = rtrp.no_nota
              AND rtr.outlet LIKE '%legenda%'
              AND (rtr.nama_item LIKE '%haji%' OR rtr.customer_nama LIKE '%haji%')
      )
    GROUP BY outlet, tanggal
    UNION ALL
    SELECT outlet COLLATE utf8mb4_unicode_ci AS outlet,
           DATE(rpe.tanggal_beli) AS tanggal,
           SUM(rpe.grand_total)   AS total
    FROM rekap_pembelian_emoney rpe
    WHERE DATE(rpe.tanggal_beli) BETWEEN ? AND ?
      AND (${hasOutletFilter ? emoneyOutletFilter.clause : "1=1"})
    GROUP BY outlet, tanggal
) x
GROUP BY tanggal
ORDER BY tanggal`;

    const trendWaschenParams = [
      dateStart, effectiveAsOfDate,  // reguler range
      ...EXCLUDED_NOTAS,
      ...(hasOutletFilter ? regulerOutletFilter.params : []),  // filter reguler
      dateStart, effectiveAsOfDate,  // emoney range
      ...(hasOutletFilter ? emoneyOutletFilter.params : []),   // filter emoney
    ];

    const [[outletRows], [trendRows], [trendWaschenRows]] = await Promise.all([
      safeSmartlinkQuery(mainSql, mainParams),
      safeSmartlinkQuery(trendSql, trendParams),
      safeSmartlinkQuery(trendWaschenSql, trendWaschenParams),
    ]);

    const mapTrend = (r) => ({
      day: String(parseInt(r.tanggal.split("-")[2])),
      date: r.tanggal,
      sales: Number(r.sales),
    });

    res.json({
      outlets: outletRows,
      trend:        trendRows.map(mapTrend),
      trendWaschen: trendWaschenRows.map(mapTrend),
      meta: { asOfDate: effectiveAsOfDate, dateStart, dateEnd },
    });
  } catch (err) {
    console.error("[salesController.getPenjualan]", err);
    res.status(500).json({ message: err.message });
  }
};