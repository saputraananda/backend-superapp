import { safeQuery, safeSmartlinkQuery } from "../db/pool.js";

export const getApps = async (req, res) => {
  console.log("[API] /apps endpoint hit");

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized: not logged in" });
  }

  const [userRows] = await safeQuery(
    "SELECT role FROM users WHERE id = ?",
    [userId]
  );
  if (userRows.length === 0) {
    return res.status(401).json({ message: "User not found" });
  }

  const myRole = userRows[0].role;

  const [apps] = await safeQuery(
    `SELECT id, name, description, href, authorization, is_active 
     FROM mst_apps 
     WHERE is_active = 1 
     ORDER BY sort_order ASC`
  );

  const filteredApps = apps.filter(app => {
    if (!app.authorization) return false;
    const allowedRoles = app.authorization.split(",").map(r => r.trim());
    return allowedRoles.includes(myRole);
  });

  res.json({ apps: filteredApps });
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Get Sales Stats dari Smartlink DB
// ═══════════════════════════════════════════════════════════════════════════
export const getSalesStats = async (req, res) => {
  try {
    console.log("[API] /apps/smartlink/sales-stats endpoint hit");

    // Query kompleks dari user (dengan sedikit penyesuaian)
    const sql = `
      WITH param AS (
        SELECT
          CURDATE() AS today,
          DAY(CURDATE()) AS hari_ini,
          CASE 
            WHEN DAY(CURDATE()) > 25 
              THEN DATE(CONCAT(YEAR(CURDATE()), '-', MONTH(CURDATE()), '-26'))
            ELSE 
              DATE(CONCAT(
                YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)), '-', 
                MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)), '-26'
              ))
          END AS date_start,
          CASE 
            WHEN DAY(CURDATE()) > 25 
              THEN DATE(CONCAT(
                YEAR(DATE_ADD(CURDATE(), INTERVAL 1 MONTH)), '-', 
                MONTH(DATE_ADD(CURDATE(), INTERVAL 1 MONTH)), '-25'
              ))
            ELSE 
              DATE(CONCAT(YEAR(CURDATE()), '-', MONTH(CURDATE()), '-25'))
          END AS date_end,
          DATE_SUB(CURDATE(), INTERVAL 1 DAY) AS yesterday
      ),
      reguler_daily AS (
        SELECT 
          outlet, 
          DATE(rtrp.waktu_pembayaran) AS tanggal, 
          SUM(rtrp.nominal_bayar) AS total_bayar
        FROM rekap_transaksi_reguler_pembayaran rtrp
        JOIN param p 
          ON DATE(rtrp.waktu_pembayaran) 
          BETWEEN p.date_start AND p.yesterday
        WHERE jenis_bayar <> 'e-money' 
          AND no_nota NOT IN ('JDS250308134809893','JRC250412083723856','LKZ250422142258203','QSE250429084550314','POS250430090223407','MDR250430160351857','TSI250501092607556','YOX250501094449877','PWX250501094618850','CAY250501162309243','AIR250502165019925','VYO250504101231388','BPZ250505153114890','YNZ250506084550029','LPA250509104354921','JKM250509133602454','ATR250509155731919','UVN250509155937609','COZ250510085855458','KCE250510092127311','PPR250511104248281','ULX250511141125683','CPD250511150921365','MSB250512102328567','YSS250512142214977','ESY250514094634398','VOE250514104206010','NPA250514134849617','KIZ250514150134296','RJR250514150240950','VBJ250521105035645','WSL250612090231990','XND250612090410209','ESZ250622092835859','VRB250705145607387','WNP250707092257535','ZQN250707095003871','ZQG250723150341368','SNR250726152557061','ZTZ250819164141353','MLL250911095440273','OXI250916160645735','TYO250919133458354','OSD250919135615402','QGC250927143951995','FGH251010145932475','EYF251013085108373','VPA251015090406450','LIZ251019134650581','DOT251027093136503','ORC251027100046038','KZZ251119154110977')
        GROUP BY 1, 2
      ),
      emoney_daily AS (
        SELECT 
          outlet,
          DATE(rpe.tanggal_beli) AS tanggal,
          SUM(rpe.grand_total) AS total_saldo
        FROM rekap_pembelian_emoney rpe
        JOIN param p 
          ON DATE(rpe.tanggal_beli) 
          BETWEEN p.date_start AND p.yesterday
        GROUP BY 1, 2
      ),
      combined_daily AS (
        SELECT
          COALESCE(r.outlet, e.outlet) COLLATE utf8mb4_unicode_ci AS outlet,
          COALESCE(r.tanggal, e.tanggal) AS tanggal,
          COALESCE(r.total_bayar, 0) + COALESCE(e.total_saldo, 0) AS total_revenue
        FROM reguler_daily r
        LEFT JOIN emoney_daily e
          ON r.outlet COLLATE utf8mb4_unicode_ci = e.outlet
          AND r.tanggal = e.tanggal
        UNION ALL
        SELECT
          COALESCE(r.outlet, e.outlet) COLLATE utf8mb4_unicode_ci AS outlet,
          COALESCE(r.tanggal, e.tanggal) AS tanggal,
          COALESCE(r.total_bayar, 0) + COALESCE(e.total_saldo, 0) AS total_revenue
        FROM reguler_daily r
        RIGHT JOIN emoney_daily e
          ON r.outlet COLLATE utf8mb4_unicode_ci = e.outlet
          AND r.tanggal = e.tanggal
        WHERE r.outlet IS NULL
      ),
      actual AS (
        SELECT
          outlet,
          SUM(total_revenue) AS actual_sales
        FROM combined_daily
        GROUP BY outlet
      )
      SELECT
        t.outlet,
        p.date_start,
        p.yesterday,
        p.date_end,
        DATEDIFF(p.yesterday, p.date_start) + 1 AS date_count,
        DATEDIFF(p.date_end, p.date_start) + 1 AS total_day,
        ROUND(((DATEDIFF(p.yesterday, p.date_start) + 1) /
        (DATEDIFF(p.date_end, p.date_start) + 1))*100,2) AS persen_target_kumulatif,
        ((DATEDIFF(p.yesterday, p.date_start) + 1) /
        (DATEDIFF(p.date_end, p.date_start) + 1)) * t.nominal AS target_kumulatif_sales,
        t.nominal AS target_bulanan,
        COALESCE(a.actual_sales, 0) AS actual_sales,
        (
          COALESCE(a.actual_sales, 0)
          -
          (((DATEDIFF(p.yesterday, p.date_start) + 1) /
          (DATEDIFF(p.date_end, p.date_start) + 1)) * t.nominal)
        ) AS gap_nominal,
        ROUND((COALESCE(a.actual_sales, 0) / NULLIF(t.nominal, 0))*100,2) AS persen_actual,
        ROUND(((
          (COALESCE(a.actual_sales, 0) / NULLIF(t.nominal, 0))
          -
          (
            (DATEDIFF(p.yesterday, p.date_start) + 1) /
            (DATEDIFF(p.date_end, p.date_start) + 1)
          )
        ))*100,2) AS persen_gap
      FROM param p
      CROSS JOIN target_sales t
        ON t.tahun = YEAR(p.date_end) AND t.bulan = MONTH(p.date_end)
      LEFT JOIN actual a 
        ON a.outlet COLLATE utf8mb4_unicode_ci
        = t.outlet COLLATE utf8mb4_unicode_ci
      ORDER BY t.outlet
    `;

    const [rows] = await safeSmartlinkQuery(sql, []);

    // Aggregate: sum actual_sales & target_bulanan
    const totalActual = rows.reduce((sum, row) => sum + (Number(row.actual_sales) || 0), 0);
    const totalTarget = rows.reduce((sum, row) => sum + (Number(row.target_bulanan) || 0), 0);
    const percentage = totalTarget > 0 ? Math.round((totalActual / totalTarget) * 100) : 0;

    // ✨ TAMBAHKAN: AVG persen_gap untuk growth
    const avgPersenGap = rows.length > 0
      ? rows.reduce((sum, row) => sum + (Number(row.persen_gap) || 0), 0) / rows.length
      : 0;

    res.json({
      success: true,
      data: {
        actual_sales: totalActual,
        target_bulanan: totalTarget,
        percentage,
        sales_growth: Number(avgPersenGap.toFixed(2)), // ← tambahkan ini
        period_start: rows[0]?.date_start || null,
        period_end: rows[0]?.date_end || null,
        detail_per_outlet: rows,
      },
    });

  } catch (error) {
    console.error("[getSalesStats] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data sales",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// NEW: Get Customer Target dari Smartlink DB
// ═══════════════════════════════════════════════════════════════════════════
export const getCustomerTargets = async (req, res) => {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const pad = (n) => String(n).padStart(2, "0");
    const obsStart = `${currentYear}-01-26`;
    const obsEnd = `${currentYear}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const [targetRows] = await safeSmartlinkQuery(
      "SELECT jumlah FROM target_customer WHERE tahun = ?",
      [currentYear]
    );
    const targetCustomer = targetRows.length > 0 ? Number(targetRows[0].jumlah) : 0;

    const [existingRows] = await safeSmartlinkQuery(
      "SELECT jumlah FROM target_customer WHERE tahun = ?",
      [currentYear - 1]
    );
    const existingCustomer = existingRows.length > 0 ? Number(existingRows[0].jumlah) : 0;

    const sql = `
      WITH cust AS (
        SELECT
          CONCAT_WS('|',
            LOWER(TRIM(nama)) COLLATE utf8mb4_unicode_ci,
            REGEXP_REPLACE(nomor_telpon,'[^0-9]','') COLLATE utf8mb4_unicode_ci
          ) AS customer_key,
          CASE
            WHEN DATE(terdaftar_sejak) BETWEEN ? AND ?
            THEN 'Pelanggan Baru'
            ELSE 'Pelanggan Lama'
          END AS status_pelanggan
        FROM customer
        WHERE nama NOT LIKE '%haji%'
          AND nama NOT LIKE '%tni%'
          AND nama NOT LIKE '%dumm%'
          AND nama NOT LIKE '%tes%'
          AND DATE(terdaftar_sejak) <= ?
      ),
      txn_big AS (
        SELECT DISTINCT
          CONCAT_WS('|',
            LOWER(TRIM(customer_nama)) COLLATE utf8mb4_unicode_ci,
            REGEXP_REPLACE(customer_telepon,'[^0-9]','') COLLATE utf8mb4_unicode_ci
          ) AS customer_key
        FROM rekap_transaksi_reguler r
        WHERE DATE(r.tgl_terima) BETWEEN ? AND ?
          AND r.nama_item NOT LIKE '%haji%'
      ),
      txn_after_cutoff AS (
        SELECT DISTINCT
          CONCAT_WS('|',
            LOWER(TRIM(customer_nama)) COLLATE utf8mb4_unicode_ci,
            REGEXP_REPLACE(customer_telepon,'[^0-9]','') COLLATE utf8mb4_unicode_ci
          ) AS customer_key
        FROM rekap_transaksi_reguler r
        WHERE DATE(r.tgl_terima) >= ?
          AND r.nama_item NOT LIKE '%haji%'
      ),
      final AS (
        SELECT
          c.status_pelanggan,
          CASE WHEN tb.customer_key IS NOT NULL THEN 1 ELSE 0 END AS aktif_periode_besar
        FROM cust c
        LEFT JOIN txn_big tb ON c.customer_key = tb.customer_key
        LEFT JOIN txn_after_cutoff ta ON c.customer_key = ta.customer_key
      )
      SELECT
        SUM(status_pelanggan='Pelanggan Baru' AND aktif_periode_besar=1) AS new_customer_transaksi
      FROM final
    `;

    const [rows] = await safeSmartlinkQuery(sql, [
      obsStart, obsEnd, // cust: terdaftar_sejak BETWEEN
      obsEnd,           // cust: terdaftar_sejak <=
      obsStart, obsEnd, // txn_big: tgl_terima BETWEEN
      obsStart,         // txn_after_cutoff: tgl_terima >=
    ]);

    const newCustomerTransaksi = rows.length > 0 ? Number(rows[0].new_customer_transaksi) || 0 : 0;
    const actualCustomer = existingCustomer + newCustomerTransaksi;
    const percentage = targetCustomer > 0 ? Math.round((actualCustomer / targetCustomer) * 100) : 0;

    res.json({
      success: true,
      data: {
        actual_customer: actualCustomer,
        target_customer: targetCustomer,
        percentage,
        obs_start: obsStart,
        obs_end: obsEnd,
        year: currentYear,
      },
    });
  } catch (error) {
    console.error("[getCustomerTargets] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Gagal mengambil data customer",
    });
  }
};