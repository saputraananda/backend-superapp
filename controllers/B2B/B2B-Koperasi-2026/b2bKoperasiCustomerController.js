// src/controllers/B2B/B2B-Koperasi-2026/b2bKoperasiCustomerController.js
import { safeBackupCleanoxQuery } from "../../../db/pool.js";

const TABLE = "customer_cleanox";
const TX_TABLE = "rekap_transaksi_reguler";
const KMP_FILTER = "(nama LIKE '%KMP%' OR instansi LIKE '%KMP%')";

// ─── GET /kmp/customers/stats — summary cards for KMP customers ─────────────
export const getKmpCustomerStats = async (req, res) => {
  try {
    // 1. Total KMP customers
    const [[totals]] = await safeBackupCleanoxQuery(
      `SELECT
         COUNT(*) AS total_customer,
         COALESCE(SUM(total_jumlah_transaksi), 0) AS total_transaksi,
         COALESCE(SUM(total_nominal_transaksi), 0) AS total_nominal,
         COALESCE(SUM(saldo_epayment), 0) AS total_saldo,
         COALESCE(AVG(total_jumlah_transaksi), 0) AS avg_transaksi,
         COALESCE(AVG(total_nominal_transaksi), 0) AS avg_nominal
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1`
    );

    // 2. Member breakdown
    const [members] = await safeBackupCleanoxQuery(
      `SELECT
         COALESCE(member, 'Non-Member') AS member_type,
         COUNT(*) AS total,
         COALESCE(SUM(total_nominal_transaksi), 0) AS total_nominal
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
       GROUP BY COALESCE(member, 'Non-Member')
       ORDER BY total DESC`
    );

    // 3. Outlet breakdown
    const [outlets] = await safeBackupCleanoxQuery(
      `SELECT outlet, COUNT(*) AS total,
              COALESCE(SUM(total_nominal_transaksi), 0) AS total_nominal
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
       GROUP BY outlet
       ORDER BY total DESC`
    );

    // 4. Top 10 customers by nominal
    const [topCustomers] = await safeBackupCleanoxQuery(
      `SELECT id_konsumen, nama, nomor_telpon, outlet, member, instansi,
              total_jumlah_transaksi, total_nominal_transaksi, saldo_epayment,
              transaksi_terakhir
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
       ORDER BY total_nominal_transaksi DESC
       LIMIT 10`
    );

    // 5. Registration trend (monthly)
    const [regTrend] = await safeBackupCleanoxQuery(
      `SELECT DATE_FORMAT(terdaftar_sejak, '%Y-%m') AS month, COUNT(*) AS total
       FROM ${TABLE}
       WHERE ${KMP_FILTER} AND is_active = 1
       GROUP BY DATE_FORMAT(terdaftar_sejak, '%Y-%m')
       ORDER BY month DESC
       LIMIT 12`
    );

    res.json({
      data: {
        summary: totals || {},
        members,
        outlets,
        top_customers: topCustomers,
        registration_trend: regTrend,
      },
    });
  } catch (err) {
    console.error("getKmpCustomerStats:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /kmp/customers — paginated list with filters ────────────────────────
export const getKmpCustomers = async (req, res) => {
  try {
    const {
      page = 1, limit = 25, search, outlet, member,
      sort = "total_nominal_transaksi", order = "desc",
    } = req.query;

    const pg = Math.max(1, Number(page) || 1);
    const lm = Math.min(Math.max(1, Number(limit) || 25), 200);
    const offset = (pg - 1) * lm;

    const where = [KMP_FILTER, "is_active = 1"];
    const params = [];

    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(nama LIKE ? OR id_konsumen LIKE ? OR nomor_telpon LIKE ? OR instansi LIKE ?)");
      params.push(like, like, like, like);
    }
    if (outlet?.trim()) {
      where.push("outlet = ?");
      params.push(outlet.trim());
    }
    if (member?.trim()) {
      if (member === "Non-Member") {
        where.push("(member IS NULL OR member = '')");
      } else {
        where.push("member = ?");
        params.push(member.trim());
      }
    }

    const allowedSorts = [
      "nama", "total_jumlah_transaksi", "total_nominal_transaksi",
      "terdaftar_sejak", "transaksi_terakhir", "saldo_epayment",
    ];
    const sortCol = allowedSorts.includes(sort) ? sort : "total_nominal_transaksi";
    const sortDir = order === "asc" ? "ASC" : "DESC";

    const whereSql = where.join(" AND ");

    const [[{ total }]] = await safeBackupCleanoxQuery(
      `SELECT COUNT(*) AS total FROM ${TABLE} WHERE ${whereSql}`,
      params
    );

    const [rows] = await safeBackupCleanoxQuery(
      `SELECT * FROM ${TABLE}
       WHERE ${whereSql}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    // Distinct outlets & members for filter dropdowns
    const [outletList] = await safeBackupCleanoxQuery(
      `SELECT DISTINCT outlet FROM ${TABLE} WHERE ${KMP_FILTER} AND is_active = 1 ORDER BY outlet`
    );
    const [memberList] = await safeBackupCleanoxQuery(
      `SELECT DISTINCT COALESCE(NULLIF(member, ''), 'Non-Member') AS member
       FROM ${TABLE} WHERE ${KMP_FILTER} AND is_active = 1 ORDER BY member`
    );

    res.json({
      data: rows,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      meta: {
        outlets: outletList.map(r => r.outlet),
        members: memberList.map(r => r.member),
      },
    });
  } catch (err) {
    console.error("getKmpCustomers:", err);
    res.status(500).json({ message: err.message });
  }
};

// ─── GET /kmp/customers/detail/:id — single customer detail + transactions ──
export const getKmpCustomerDetail = async (req, res) => {
  try {
    const { id } = req.params;

    // Customer info
    const [customerRows] = await safeBackupCleanoxQuery(
      `SELECT * FROM ${TABLE} WHERE id_konsumen = ? AND is_active = 1 LIMIT 1`,
      [id]
    );

    if (customerRows.length === 0) {
      return res.status(404).json({ message: "Customer not found" });
    }
    const customer = customerRows[0];

    // Transaction history from rekap_transaksi_reguler (KMP only)
    const [transactions] = await safeBackupCleanoxQuery(
      `SELECT no_nota, outlet, tgl_terima, tgl_selesai, total_tagihan, pembayaran,
              jenis_layanan, nama_item, jumlah, satuan_item, total, item_ke
       FROM ${TX_TABLE}
       WHERE (customer_nama = ? OR customer_nama LIKE ?)
         AND (nama_item LIKE '%KMP%' OR customer_nama LIKE '%KMP%')
         AND is_active = 1
       ORDER BY tgl_terima DESC, no_nota, item_ke
       LIMIT 200`,
      [customer.nama, `%${customer.nama}%`]
    );

    // Transaction summary
    const [[txSummary]] = await safeBackupCleanoxQuery(
      `SELECT COUNT(DISTINCT no_nota) AS total_nota, COUNT(*) AS total_items,
              COALESCE(SUM(total_tagihan), 0) AS total_tagihan,
              COALESCE(SUM(total), 0) AS grand_total
       FROM ${TX_TABLE}
       WHERE (customer_nama = ? OR customer_nama LIKE ?)
         AND (nama_item LIKE '%KMP%' OR customer_nama LIKE '%KMP%')
         AND is_active = 1`,
      [customer.nama, `%${customer.nama}%`]
    );

    res.json({
      data: {
        customer,
        transactions,
        tx_summary: txSummary || {},
      },
    });
  } catch (err) {
    console.error("getKmpCustomerDetail:", err);
    res.status(500).json({ message: err.message });
  }
};
