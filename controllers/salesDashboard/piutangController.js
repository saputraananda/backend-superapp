import { safeSmartlinkQuery } from "../../db/pool.js";

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

export const getPiutang = async (req, res) => {
  try {
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let { asOfDate, startDate, endDate, outlet = "all" } = req.query;

    if (asOfDate  && !dateRe.test(asOfDate))  return res.status(400).json({ message: "Format asOfDate harus YYYY-MM-DD" });
    if (startDate && !dateRe.test(startDate)) return res.status(400).json({ message: "Format startDate harus YYYY-MM-DD" });
    if (endDate   && !dateRe.test(endDate))   return res.status(400).json({ message: "Format endDate harus YYYY-MM-DD" });

    const isRange = !!(startDate && endDate);

    let dateStart, dateEnd;
    if (isRange) {
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
      ({ dateStart, dateEnd } = computeDateRange(asOfDate));
    }

    const sql = `
      WITH nota_level AS (
        SELECT
          rtr.no_nota,
          MAX(rtr.customer_nama)              AS customer_nama,
          MAX(rtr.outlet)                     AS outlet,
          MAX(rtr.tgl_terima)                 AS tgl_terima,
          MAX(rtr.tgl_selesai)                AS tgl_selesai,
          COALESCE(MAX(rtr.total_tagihan), 0) AS total_tagihan
        FROM rekap_transaksi_reguler rtr
        WHERE rtr.customer_nama NOT LIKE '%dum%'
          AND rtr.customer_nama NOT LIKE '%test%'
          AND rtr.customer_nama NOT LIKE '%nur kholifah%'
          AND rtr.customer_nama NOT LIKE '%kiyalalala%'
          AND rtr.customer_nama NOT LIKE 'Tiya Raffles'
          AND rtr.nama_item     NOT LIKE '%haji%'
          AND rtr.customer_nama NOT LIKE '%haji%'
          AND rtr.nama_item     NOT LIKE '%cleanox%'
          AND rtr.pembayaran = 'Belum Lunas'
          AND rtr.pengambilan IN ('Belum Diambil', 'Diambil Semua')
          AND rtr.tgl_selesai IS NOT NULL
          AND (? = 'all' OR LOWER(rtr.outlet) = LOWER(?))
        GROUP BY rtr.no_nota
      )
      SELECT
        CASE
          WHEN outlet LIKE '%Raffles Hills%'   THEN 'Raffles Hills'
          WHEN outlet LIKE '%Legenda Wisata%'  THEN 'Legenda Wisata'
          WHEN outlet LIKE '%Canadian%'        THEN 'Canadian'
          WHEN outlet LIKE '%Kota Wisata%'     THEN 'Kota Wisata'
          WHEN outlet LIKE '%Citra Grand%'     THEN 'Citra Grand'
          ELSE outlet
        END AS outlet,
        customer_nama,
        no_nota,
        DATE(tgl_terima)  AS tgl_terima,
        DATE(tgl_selesai) AS tgl_selesai,
        total_tagihan     AS piutang,
        CASE
          WHEN DATE(tgl_selesai) < CURDATE() THEN 'Terlambat'
          WHEN DATE(tgl_selesai) = CURDATE() THEN 'Jatuh Tempo'
          ELSE 'Belum Jatuh Tempo'
        END AS status
      FROM nota_level
      WHERE tgl_terima >= ?
        AND tgl_terima <  DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY tgl_terima ASC, customer_nama ASC, no_nota ASC
    `;

    const [rows] = await safeSmartlinkQuery(sql, [outlet, outlet, dateStart, dateEnd]);

    const total      = rows.reduce((a, r) => a + Number(r.piutang), 0);
    const jatuhTempo = rows.filter(r => r.status === "Jatuh Tempo").reduce((a, r) => a + Number(r.piutang), 0);
    const terlambat  = rows.filter(r => r.status === "Terlambat").reduce((a, r) => a + Number(r.piutang), 0);

    const outletMap = {};
    for (const r of rows) {
      const key = r.outlet || "Unknown";
      outletMap[key] = (outletMap[key] || 0) + Number(r.piutang);
    }
    const perOutlet = Object.entries(outletMap)
      .map(([o, t]) => ({ outlet: o, total: t }))
      .sort((a, b) => b.total - a.total);

    res.json({
      piutang: rows,
      summary: { total, jatuh_tempo: jatuhTempo, terlambat },
      per_outlet: perOutlet,
      meta: { dateStart, dateEnd },
    });
  } catch (err) {
    console.error("[piutangController.getPiutang]", err);
    res.status(500).json({ message: err.message });
  }
};