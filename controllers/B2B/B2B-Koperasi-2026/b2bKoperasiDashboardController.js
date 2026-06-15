// src/controllers/B2B/b2bKoperasiController.js
import { safeBackupCleanoxQuery } from "../../../db/pool.js";

const TABLE = "rekap_transaksi_reguler";
const KMP_FILTER = "(nama_item LIKE '%KMP%' OR customer_nama LIKE '%KMP%')";

// ─── GET /stats — Dashboard summary for KMP ─────────────────────────────────
export const getKmpStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const dateFilter = [];
    const dateParams = [];
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      dateFilter.push("tgl_terima >= ?");
      dateParams.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      dateFilter.push("tgl_terima <= ?");
      dateParams.push(endDate + " 23:59:59");
    }

    const kmpDateFilter = dateFilter.length
      ? `${KMP_FILTER} AND ${dateFilter.join(" AND ")}`
      : KMP_FILTER;

    // 1. Overall summary
    const [[summary]] = await safeBackupCleanoxQuery(
      `SELECT
         COUNT(DISTINCT no_nota) AS total_nota,
         COUNT(*) AS total_items,
         COALESCE(SUM(total), 0) AS grand_total,
         COALESCE(SUM(subtotal), 0) AS total_subtotal,
         COALESCE(SUM(diskon), 0) AS total_diskon,
         COALESCE(SUM(pajak), 0) AS total_pajak,
         COALESCE(SUM(biaya_service), 0) AS total_biaya_service,
         COALESCE(SUM(total_tagihan), 0) AS total_tagihan
       FROM ${TABLE}
       WHERE ${kmpDateFilter} AND is_active = 1`,
      dateParams
    );

    // 2. By outlet
    const [outlets] = await safeBackupCleanoxQuery(
      `SELECT outlet, COUNT(DISTINCT no_nota) AS total_nota,
              COALESCE(SUM(total_tagihan), 0) AS total_tagihan
       FROM ${TABLE}
       WHERE ${kmpDateFilter} AND is_active = 1
       GROUP BY outlet
       ORDER BY total_tagihan DESC`,
      dateParams
    );

    // 3. By pembayaran
    const [payments] = await safeBackupCleanoxQuery(
      `SELECT pembayaran, COUNT(DISTINCT no_nota) AS total_nota,
              COALESCE(SUM(total_tagihan), 0) AS total_tagihan
       FROM ${TABLE}
       WHERE ${kmpDateFilter} AND is_active = 1
       GROUP BY pembayaran
       ORDER BY total_nota DESC`,
      dateParams
    );

    // 4. By jenis_layanan
    const [services] = await safeBackupCleanoxQuery(
      `SELECT jenis_layanan, COUNT(*) AS total,
              COALESCE(SUM(total), 0) AS total_revenue
       FROM ${TABLE}
       WHERE ${kmpDateFilter} AND is_active = 1
       GROUP BY jenis_layanan
       ORDER BY total_revenue DESC
       LIMIT 10`,
      dateParams
    );

    // 5. Monthly trend (last 12 months)
    const [trend] = await safeBackupCleanoxQuery(
      `SELECT
         DATE_FORMAT(tgl_terima, '%Y-%m') AS month,
         COUNT(DISTINCT no_nota) AS total_nota,
         COALESCE(SUM(total_tagihan), 0) AS total_tagihan
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
         AND tgl_terima >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(tgl_terima, '%Y-%m')
       ORDER BY month ASC`
    );

    // 6. Recent transactions (latest 20)
    const [recent] = await safeBackupCleanoxQuery(
      `SELECT id, no_nota, customer_nama, customer_telepon, outlet,
              tgl_terima, tgl_selesai, total_tagihan, pembayaran,
              jenis_layanan, nama_item, jumlah, satuan_item, total
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
       ORDER BY tgl_terima DESC
       LIMIT 20`
    );

    res.json({
      data: {
        summary: summary || {},
        outlets,
        payments,
        services,
        monthly_trend: trend,
        recent_transactions: recent,
      },
    });
  } catch (err) {
    console.error("getKmpStats:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /transactions — List with pagination & filters ──────────────────────
export const getKmpTransactions = async (req, res) => {
  try {
    const {
      page = 1, limit = 25, search, outlet, pembayaran,
      jenis_layanan, startDate, endDate,
    } = req.query;

    const pg = Math.max(1, Number(page) || 1);
    const lm = Math.min(Math.max(1, Number(limit) || 25), 200);
    const offset = (pg - 1) * lm;

    const where = [KMP_FILTER, "is_active = 1"];
    const params = [];

    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(no_nota LIKE ? OR customer_nama LIKE ? OR customer_telepon LIKE ? OR nama_item LIKE ?)");
      params.push(like, like, like, like);
    }
    if (outlet?.trim()) {
      where.push("outlet = ?");
      params.push(outlet.trim());
    }
    if (pembayaran?.trim()) {
      where.push("pembayaran = ?");
      params.push(pembayaran.trim());
    }
    if (jenis_layanan?.trim()) {
      where.push("jenis_layanan = ?");
      params.push(jenis_layanan.trim());
    }
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      where.push("tgl_terima >= ?");
      params.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      where.push("tgl_terima <= ?");
      params.push(endDate + " 23:59:59");
    }

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await safeBackupCleanoxQuery(
      `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${whereSql}`,
      params
    );

    const [rows] = await safeBackupCleanoxQuery(
      `SELECT * FROM ${TABLE}
       WHERE ${whereSql}
       ORDER BY tgl_terima DESC, no_nota, item_ke
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    // Get distinct outlets & pembayaran for filter dropdowns
    const [outletList] = await safeBackupCleanoxQuery(
      `SELECT DISTINCT outlet FROM ${TABLE} WHERE ${KMP_FILTER} AND is_active = 1 ORDER BY outlet`
    );
    const [paymentList] = await safeBackupCleanoxQuery(
      `SELECT DISTINCT pembayaran FROM ${TABLE} WHERE ${KMP_FILTER} AND is_active = 1 AND pembayaran IS NOT NULL ORDER BY pembayaran`
    );

    res.json({
      data: rows,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      meta: {
        outlets: outletList.map(r => r.outlet),
        payments: paymentList.map(r => r.pembayaran),
      },
    });
  } catch (err) {
    console.error("getKmpTransactions:", err);
    res.status(500).json({ message: err.message });
  }
};
