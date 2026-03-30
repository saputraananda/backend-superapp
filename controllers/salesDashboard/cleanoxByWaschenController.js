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

const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE  = /^\d{4}$/;

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
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };
  return { dateStart: fmt(dateStart), dateEnd: fmt(dateEnd) };
}

function buildDateRange(filterType, month, year, startDate, endDate, asOfDate) {
  const today = new Date().toISOString().split("T")[0];
  if (filterType === "range" && startDate && endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate)) {
    return { dateStart: startDate, dateEnd: endDate, asOfDate: endDate };
  }
  if (filterType === "month" && month && MONTH_RE.test(month)) {
    const ao = `${month}-25`;
    return { ...computeDateRange(ao), asOfDate: ao };
  }
  if (filterType === "year" && year && YEAR_RE.test(year)) {
    const yearStart = `${parseInt(year) - 1}-12-26`;
    const yearEnd   = `${year}-12-25`;
    const ao        = today < yearEnd ? today : yearEnd;
    return { dateStart: yearStart, dateEnd: yearEnd, asOfDate: ao };
  }
  // asOfDate sent directly by frontend (e.g. month filter → asOfDate=YYYY-MM-25)
  if (asOfDate && DATE_RE.test(asOfDate)) {
    return { ...computeDateRange(asOfDate), asOfDate };
  }
  // default: current billing cycle up to yesterday
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const ao = yesterday.toISOString().split("T")[0];
  return { ...computeDateRange(ao), asOfDate: ao };
}

export const getCleanoxByWaschen = async (req, res) => {
  try {
    const {
      outlet = "all",
      filterType,
      month,
      year,
      startDate,
      endDate,
      asOfDate: rawAsOfDate,
      page = "1",
      pageSize = "50",
    } = req.query;

    // Validate outlet
    if (outlet !== "all" && typeof outlet !== "string")
      return res.status(400).json({ message: "Parameter outlet tidak valid" });

    const pg   = Math.max(1, parseInt(page)     || 1);
    const size = Math.min(200, Math.max(1, parseInt(pageSize) || 50));
    const offset = (pg - 1) * size;

    const { dateStart, dateEnd, asOfDate } = buildDateRange(filterType, month, year, startDate, endDate, rawAsOfDate);

    const EP     = EXCLUDED_NOTAS.map(() => "?").join(",");
    const outletFilter = outlet !== "all" ? "AND LOWER(ppn.outlet) = LOWER(?)" : "";
    const outletParam  = outlet !== "all" ? [outlet] : [];

    // ── 1. Detail rows ────────────────────────────────────────────────────
    const detailSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MIN(rtrp.waktu_pembayaran) AS waktu_pembayaran,
        SUM(rtrp.nominal_bayar)    AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
nota_info AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(rtr.customer_nama)  AS customer_nama,
        MAX(rtr.outlet)         AS outlet_nota,
        MAX(rtr.tgl_terima)     AS tgl_terima,
        MAX(rtr.tgl_selesai)    AS tgl_selesai,
        MAX(rtr.pembuat_nota)   AS pembuat_nota,
        GROUP_CONCAT(DISTINCT rtr.nama_item ORDER BY rtr.nama_item SEPARATOR ', ') AS daftar_item
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
)
SELECT
    ppn.outlet,
    ppn.no_nota,
    ni.customer_nama,
    ni.pembuat_nota,
    ni.tgl_terima,
    ni.tgl_selesai,
    ppn.waktu_pembayaran,
    ppn.nominal_bayar,
    ni.daftar_item
FROM payment_per_nota ppn
LEFT JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
LEFT JOIN nota_info ni ON ppn.no_nota = ni.no_nota
WHERE COALESCE(nf.is_cleanox, 0) = 1
  ${outletFilter}
ORDER BY ppn.outlet, ppn.waktu_pembayaran, ppn.no_nota
LIMIT ? OFFSET ?`;

    // ── 2. KPI summary ────────────────────────────────────────────────────
    const kpiSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        SUM(rtrp.nominal_bayar) AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
cleanox AS (
    SELECT ppn.outlet, ppn.nominal_bayar
    FROM payment_per_nota ppn
    JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
    WHERE COALESCE(nf.is_cleanox, 0) = 1
      ${outletFilter}
)
SELECT
    COUNT(*)                 AS total_nota,
    SUM(nominal_bayar)       AS total_omzet,
    SUM(nominal_bayar)*0.70  AS jatah_70,
    SUM(nominal_bayar)*0.30  AS jatah_30,
    AVG(nominal_bayar)       AS avg_per_nota
FROM cleanox`;

    // ── 3. Per-outlet breakdown ───────────────────────────────────────────
    const outletSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        SUM(rtrp.nominal_bayar) AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
cleanox AS (
    SELECT ppn.outlet, ppn.no_nota, ppn.nominal_bayar
    FROM payment_per_nota ppn
    JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
    WHERE COALESCE(nf.is_cleanox, 0) = 1
      ${outletFilter}
)
SELECT
    outlet,
    COUNT(*)           AS total_nota,
    SUM(nominal_bayar) AS total_omzet
FROM cleanox
GROUP BY outlet
ORDER BY total_omzet DESC`;

    // ── 4. Daily trend ────────────────────────────────────────────────────
    const trendSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        DATE(MIN(rtrp.waktu_pembayaran)) AS tanggal,
        SUM(rtrp.nominal_bayar)          AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
)
SELECT
    ppn.tanggal,
    SUM(ppn.nominal_bayar) AS total
FROM payment_per_nota ppn
JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
WHERE COALESCE(nf.is_cleanox, 0) = 1
  ${outletFilter}
GROUP BY ppn.tanggal
ORDER BY ppn.tanggal`;

    // ── 5. Count total rows for pagination ───────────────────────────────
    const countSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        SUM(rtrp.nominal_bayar) AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
)
SELECT COUNT(*) AS total
FROM payment_per_nota ppn
JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
WHERE COALESCE(nf.is_cleanox, 0) = 1
  ${outletFilter}`;

    // ── 6. Klasifikasi per pembuat nota ──────────────────────────────────
    const pembuatSql = `
WITH param AS (
    SELECT DATE(?) AS date_start, DATE(?) AS date_end
),
payment_per_nota AS (
    SELECT
        rtrp.outlet COLLATE utf8mb4_unicode_ci AS outlet,
        rtrp.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        SUM(rtrp.nominal_bayar) AS nominal_bayar
    FROM rekap_transaksi_reguler_pembayaran rtrp
    JOIN param p ON DATE(rtrp.waktu_pembayaran) BETWEEN p.date_start AND p.date_end
    WHERE rtrp.jenis_bayar <> 'e-money'
      AND rtrp.no_nota NOT IN (${EP})
    GROUP BY 1, 2
),
nota_flag AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(CASE
            WHEN LOWER(COALESCE(rtr.nama_item,'')) LIKE '%cleanox%'
              OR LOWER(COALESCE(rtr.nama_item,'')) LIKE '%karpet%'
            THEN 1 ELSE 0
        END) AS is_cleanox
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
nota_info AS (
    SELECT
        rtr.no_nota COLLATE utf8mb4_unicode_ci AS no_nota,
        MAX(rtr.pembuat_nota) AS pembuat_nota,
        MAX(rtr.outlet)       AS outlet_nota
    FROM rekap_transaksi_reguler rtr
    GROUP BY 1
),
cleanox AS (
    SELECT
        COALESCE(NULLIF(TRIM(ni.pembuat_nota), ''), 'Tidak Diketahui') AS pembuat_nota,
        ppn.outlet,
        ppn.nominal_bayar
    FROM payment_per_nota ppn
    JOIN nota_flag nf ON ppn.no_nota = nf.no_nota
    JOIN nota_info ni  ON ppn.no_nota = ni.no_nota
    WHERE COALESCE(nf.is_cleanox, 0) = 1
      ${outletFilter}
)
SELECT
    pembuat_nota,
    COUNT(*)                AS total_nota,
    SUM(nominal_bayar)      AS total_omzet,
    SUM(nominal_bayar)*0.30 AS jatah_waschen
FROM cleanox
GROUP BY pembuat_nota
ORDER BY total_nota DESC, total_omzet DESC`;

    const baseRangeParams = [dateStart, dateEnd, ...EXCLUDED_NOTAS, ...outletParam];

    const [[detailRows], [kpiRows], [outletRows], [trendRows], [countRows], [pembuatRows]] = await Promise.all([
      safeSmartlinkQuery(detailSql,   [dateStart, dateEnd, ...EXCLUDED_NOTAS, ...outletParam, size, offset]),
      safeSmartlinkQuery(kpiSql,      baseRangeParams),
      safeSmartlinkQuery(outletSql,   baseRangeParams),
      safeSmartlinkQuery(trendSql,    baseRangeParams),
      safeSmartlinkQuery(countSql,    [dateStart, dateEnd, ...EXCLUDED_NOTAS, ...outletParam]),
      safeSmartlinkQuery(pembuatSql,  baseRangeParams),
    ]);

    const kpi = kpiRows[0] ?? {};
    const totalRows = Number(countRows[0]?.total) || 0;

    res.json({
      kpi: {
        total_nota:   Number(kpi.total_nota)   || 0,
        total_omzet:  Number(kpi.total_omzet)  || 0,
        jatah_70:     Number(kpi.jatah_70)     || 0,
        jatah_30:     Number(kpi.jatah_30)     || 0,
        avg_per_nota: Number(kpi.avg_per_nota) || 0,
      },
      per_outlet:   outletRows,
      per_pembuat:  pembuatRows,
      trend: trendRows.map(r => ({
        day:   String(parseInt(String(r.tanggal).split("-")[2])),
        date:  r.tanggal,
        total: Number(r.total),
      })),
      detail: detailRows,
      pagination: {
        page: pg,
        pageSize: size,
        total: totalRows,
        totalPages: Math.ceil(totalRows / size),
      },
      meta: { dateStart, dateEnd, asOfDate },
    });
  } catch (err) {
    console.error("[cleanoxByWaschenController.getCleanoxByWaschen]", err);
    res.status(500).json({ message: err.message });
  }
};
