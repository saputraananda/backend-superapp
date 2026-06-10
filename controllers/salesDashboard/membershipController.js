import { safeSmartlinkQuery } from "../../db/pool.js";

const DIAMOND_THRESHOLD = 1_050_000;
const GOLD_THRESHOLD    =   525_000;

export const getMembership = async (req, res) => {
  try {
    let outlet = req.query.outlet;
    if (!outlet) { outlet = ["all"]; }
    else if (typeof outlet === "string") { outlet = [outlet]; }

    const isAllOutlets = outlet.length === 0 || outlet.includes("all");
    let outletClause = "";
    const outletParams = [];
    if (!isAllOutlets) {
      outletClause = `AND LOWER(c.outlet) IN (${outlet.map(() => "?").join(",")})`;
      outletParams.push(...outlet.map(o => String(o).toLowerCase()));
    }

    const sql = `
      SELECT
        CASE
          WHEN c.outlet LIKE '%Raffles Hills%'   THEN 'Raffles Hills'
          WHEN c.outlet LIKE '%Legenda Wisata%'  THEN 'Legenda Wisata'
          WHEN c.outlet LIKE '%Canadian%'        THEN 'Canadian'
          WHEN c.outlet LIKE '%Kota Wisata%'     THEN 'Kota Wisata'
          WHEN c.outlet LIKE '%Citra Grand%'     THEN 'Citra Grand'
          ELSE c.outlet
        END AS outlet,
        TRIM(c.nama)                           AS nama,
        CONCAT('wa.me/', c.nomor_telpon)       AS nomor_telpon,
        COALESCE(c.saldo_epayment, 0)          AS saldo,
        t.total_topup,
        CASE
          WHEN t.total_topup >= ?  THEN 'Diamond'
          WHEN t.total_topup >= ?  THEN 'Gold'
          ELSE 'Member'
        END AS tier
      FROM (
        SELECT TRIM(customer) AS customer, SUM(grand_total) AS total_topup
        FROM rekap_pembelian_emoney
        GROUP BY TRIM(customer)
      ) t
      LEFT JOIN customer c ON TRIM(c.nama) COLLATE utf8mb4_unicode_ci = t.customer
      WHERE TRIM(c.nama) NOT LIKE '%dummy%'
        ${outletClause}
      ORDER BY t.total_topup DESC
    `;

    const [rows] = await safeSmartlinkQuery(sql, [
      DIAMOND_THRESHOLD,
      GOLD_THRESHOLD,
      ...outletParams,
    ]);

    const diamond = rows.filter(r => r.tier === "Diamond").length;
    const gold     = rows.filter(r => r.tier === "Gold").length;
    const member   = rows.filter(r => r.tier === "Member").length;

    res.json({
      members: rows,
      summary: { total: rows.length, diamond, gold, member },
    });
  } catch (err) {
    console.error("[membershipController.getMembership]", err);
    res.status(500).json({ message: err.message });
  }
};
