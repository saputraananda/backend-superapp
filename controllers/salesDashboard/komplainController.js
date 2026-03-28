import { safeSmartlinkQuery } from "../../db/pool.js";

/**
 * GET /sales/komplain
 * Query: outlet, filterType (month|year|range), month (YYYY-MM), year (YYYY),
 *        startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 */
export const getKomplain = async (req, res) => {
  try {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let { outlet = "all", filterType = "month", month, year, startDate, endDate } = req.query;

    // --- validate ---
    if (startDate && !dateRe.test(startDate)) return res.status(400).json({ message: "Format startDate harus YYYY-MM-DD" });
    if (endDate   && !dateRe.test(endDate))   return res.status(400).json({ message: "Format endDate harus YYYY-MM-DD" });

    // --- build date clause ---
    const params = [];
    let dateClause = "";

    if (filterType === "range" && startDate && endDate) {
      dateClause = "AND DATE(tanggal_temuan) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    } else if (filterType === "year" && year) {
      dateClause = "AND YEAR(tanggal_temuan) = ?";
      params.push(year);
    } else {
      // default: month filter
      const m = month || new Date().toISOString().slice(0, 7);
      dateClause = "AND DATE_FORMAT(tanggal_temuan, '%Y-%m') = ?";
      params.push(m);
    }

    // --- outlet clause ---
    let outletClause = "";
    if (outlet !== "all") {
      outletClause = "AND LOWER(cabang_waschen_laundry) LIKE LOWER(?)";
      params.push(`%${outlet}%`);
    }

    const sql = `
      SELECT
        id,
        DATE_FORMAT(tanggal_temuan, '%Y-%m-%d')  AS tanggal,
        TRIM(cabang_waschen_laundry)             AS outlet,
        TRIM(nama_pelanggan)                     AS customer,
        TRIM(nama_frontliner)                    AS frontliner,
        no_nota,
        kategori_komplain                        AS kategori,
        COALESCE(kategori_kerusakan, '')         AS kategori_kerusakan,
        deskripsi_komplain                       AS deskripsi,
        COALESCE(tindak_lanjut, '')              AS tindak_lanjut,
        COALESCE(status_penyelesaian, 'Pending') AS status,
        lampiran_komplain                        AS lampiran,
        DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i') AS created_at
      FROM complain_pelanggan
      WHERE (ada_komplain IS NULL OR ada_komplain != 'Tidak')
        ${dateClause}
        ${outletClause}
      ORDER BY tanggal_temuan DESC, id DESC
    `;

    const [rows] = await safeSmartlinkQuery(sql, params);

    // --- aggregations ---
    const totalKomplain = rows.length;

    const byStatus = { Pending: 0, Proses: 0, Selesai: 0 };
    const byKategori = {};
    const byOutlet   = {};

    for (const r of rows) {
      const st = r.status in byStatus ? r.status : "Pending";
      byStatus[st] = (byStatus[st] || 0) + 1;

      byKategori[r.kategori] = (byKategori[r.kategori] || 0) + 1;

      const outletNorm = normalizeOutlet(r.outlet);
      byOutlet[outletNorm] = (byOutlet[outletNorm] || 0) + 1;
    }

    const kategoriChart = Object.entries(byKategori)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const outletChart = Object.entries(byOutlet)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const statusDonut = [
      { name: "Pending", value: byStatus.Pending, color: "#F59E0B" },
      { name: "Proses",  value: byStatus.Proses,  color: "#60A5FA" },
      { name: "Selesai", value: byStatus.Selesai, color: "#34D399" },
    ];

    const resolvedRate = totalKomplain > 0
      ? Math.round((byStatus.Selesai / totalKomplain) * 100)
      : 0;

    res.json({
      rows,
      summary: {
        total: totalKomplain,
        pending:  byStatus.Pending,
        proses:   byStatus.Proses,
        selesai:  byStatus.Selesai,
        resolvedRate,
      },
      charts: {
        kategori: kategoriChart,
        outlet:   outletChart,
        status:   statusDonut,
      },
    });
  } catch (err) {
    console.error("[komplainController.getKomplain]", err);
    res.status(500).json({ message: err.message });
  }
};

function normalizeOutlet(raw) {
  if (!raw) return "Lainnya";
  const s = raw.toLowerCase();
  if (s.includes("raffles"))   return "Raffles Hills";
  if (s.includes("legenda"))   return "Legenda Wisata";
  if (s.includes("canadian"))  return "Canadian";
  if (s.includes("kota"))      return "Kota Wisata";
  if (s.includes("citra"))     return "Citra Grand";
  return raw;
}
