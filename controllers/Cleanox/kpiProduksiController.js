import { cleanoxPool } from "../../db/pool.js";
import ExcelJS from "exceljs";

const TRANSAKSI_TABLE = "tr_rekap_transaksi_reguler_waschen";

/* ── Helpers ────────────────────────────────────────────── */
const parseJson = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
};

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const toLocalDateKey = (v) => {
  const d = parseDate(v);
  if (!d) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const diffHours = (a, b) => {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return null;
  const h = (db.getTime() - da.getTime()) / 36e5;
  return h >= 0 ? h : null;
};

const summarizeHours = (arr) => {
  if (!arr.length) {
    return { sample_count: 0, avg_hours: null, min_hours: null, max_hours: null };
  }
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    sample_count: arr.length,
    avg_hours: Number((sum / arr.length).toFixed(2)),
    min_hours: Number(Math.min(...arr).toFixed(2)),
    max_hours: Number(Math.max(...arr).toFixed(2)),
  };
};

const normalizeServiceName = (name) => {
  const s = String(name || "").trim().replace(/\s+/g, " ");
  return s || "Tanpa Nama Item";
};

/* ── KPI Summary ────────────────────────────────────────── */
export const getKpiSummary = async (req, res) => {
  const { date_start, date_end, date_field = "tgl_terima", outlet } = req.query;

  if (!date_start || !date_end) {
    return res.status(400).json({ message: "date_start dan date_end wajib diisi" });
  }

  const dateFieldSafe = date_field === "tgl_selesai" ? "tgl_selesai" : "tgl_terima";
  const outletWhere = outlet ? "AND outlet = ?" : "";
  const outletParams = outlet ? [outlet] : [];

  const baseWhere = `
    DATE(${dateFieldSafe}) BETWEEN DATE(?) AND DATE(?)
    AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
      OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
    ${outletWhere}
  `;

  try {
    const [rows] = await cleanoxPool.query(
      `SELECT
         id, no_nota, nama_item, jumlah, satuan_item,
         COALESCE(total_tagihan, 0) AS total_tagihan,
         pickup_by, pickup_at,
         cuci_jemur_by, cuci_jemur_at,
         packing_by, packing_at,
         pengantaran_by, pengantaran_at,
         tgl_selesai
       FROM ${TRANSAKSI_TABLE}
       WHERE ${baseWhere}`,
      [date_start, date_end, ...outletParams]
    );

    // Aggregate per employee
    const empMap = {};

    const ensure = (name) => {
      if (!empMap[name]) {
        empMap[name] = {
          name,
          pickup: 0,
          cuci_jemur: 0,
          packing: 0,
          pengantaran: 0,
          total: 0,
        };
      }
      return empMap[name];
    };

    for (const r of rows) {
      const stages = [
        { names: parseJson(r.pickup_by), key: "pickup" },
        { names: parseJson(r.cuci_jemur_by), key: "cuci_jemur" },
        { names: parseJson(r.packing_by), key: "packing" },
        { names: parseJson(r.pengantaran_by), key: "pengantaran" },
      ];
      for (const { names, key } of stages) {
        for (const name of names) {
          if (!name || name === "Admin") continue;
          const emp = ensure(name);
          emp[key] += 1;
        }
      }
    }

    const list = Object.values(empMap).map((e) => ({
      ...e,
      total: e.pickup + e.cuci_jemur + e.packing + e.pengantaran,
    }));
    list.sort((a, b) => b.total - a.total);
    list.forEach((e, i) => {
      e.rank = i + 1;
    });

    // Overall stats
    const overall = {
      total_items: rows.length,
      pickup_done: rows.filter((r) => parseJson(r.pickup_by).length > 0).length,
      cuci_jemur_done: rows.filter((r) => parseJson(r.cuci_jemur_by).length > 0).length,
      packing_done: rows.filter((r) => parseJson(r.packing_by).length > 0).length,
      pengantaran_done: rows.filter((r) => parseJson(r.pengantaran_by).length > 0).length,
    };

    // 1) Daily stage
    const dailyMap = new Map();
    const ensureDaily = (dateKey) => {
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          pickup: 0,
          cuci_jemur: 0,
          packing: 0,
          pengantaran: 0,
          total: 0,
        });
      }
      return dailyMap.get(dateKey);
    };

    for (const r of rows) {
      const stageAtList = [
        { key: "pickup", at: r.pickup_at },
        { key: "cuci_jemur", at: r.cuci_jemur_at },
        { key: "packing", at: r.packing_at },
        { key: "pengantaran", at: r.pengantaran_at },
      ];
      for (const { key, at } of stageAtList) {
        const dateKey = toLocalDateKey(at);
        if (!dateKey) continue;
        const d = ensureDaily(dateKey);
        d[key] += 1;
        d.total += 1;
      }
    }

    const dailyStage = Array.from(dailyMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // 2) Aging processing time
    const pickupToCuci = [];
    const cuciToPacking = [];
    const packingToDelivery = [];
    const pickupToDelivery = [];

    for (const r of rows) {
      const h1 = diffHours(r.pickup_at, r.cuci_jemur_at);
      const h2 = diffHours(r.cuci_jemur_at, r.packing_at);
      const h3 = diffHours(r.packing_at, r.pengantaran_at);
      const h4 = diffHours(r.pickup_at, r.pengantaran_at);
      if (h1 !== null) pickupToCuci.push(h1);
      if (h2 !== null) cuciToPacking.push(h2);
      if (h3 !== null) packingToDelivery.push(h3);
      if (h4 !== null) pickupToDelivery.push(h4);
    }

    const agingProcessingHours = [
      { stage: "pickup_to_cuci_jemur", ...summarizeHours(pickupToCuci) },
      { stage: "cuci_jemur_to_packing", ...summarizeHours(cuciToPacking) },
      { stage: "packing_to_delivery", ...summarizeHours(packingToDelivery) },
      { stage: "pickup_to_delivery", ...summarizeHours(pickupToDelivery) },
    ].filter(a => a.sample_count > 0);

    // 3) Top services
    const notaItemCount = {};
    for (const r of rows) {
      const notaKey = String(r.no_nota || "").trim();
      if (!notaKey) continue;
      notaItemCount[notaKey] = (notaItemCount[notaKey] || 0) + 1;
    }

    const serviceMap = new Map();
    const ensureService = (serviceName) => {
      if (!serviceMap.has(serviceName)) {
        serviceMap.set(serviceName, {
          service_name: serviceName,
          volume: 0,
          revenue: 0,
          _cycle_sum: 0,
          _cycle_count: 0,
        });
      }
      return serviceMap.get(serviceName);
    };

    for (const r of rows) {
      const serviceName = normalizeServiceName(r.nama_item);
      const svc = ensureService(serviceName);
      svc.volume += 1;

      const rowRevenue = Number(r.total_tagihan || 0);
      if (Number.isFinite(rowRevenue)) {
        const notaKey = String(r.no_nota || "").trim();
        const divisor = notaKey ? (notaItemCount[notaKey] || 1) : 1;
        svc.revenue += rowRevenue / Math.max(1, divisor);
      }

      const cycle = diffHours(r.pickup_at, r.pengantaran_at);
      if (cycle !== null) {
        svc._cycle_sum += cycle;
        svc._cycle_count += 1;
      }
    }

    const topServices = Array.from(serviceMap.values())
      .map((s) => ({
        service_name: s.service_name,
        volume: s.volume,
        revenue: Math.round(s.revenue),
        avg_cycle_hours: s._cycle_count > 0
          ? Number((s._cycle_sum / s._cycle_count).toFixed(2))
          : null,
        cycle_sample_count: s._cycle_count,
      }))
      .sort((a, b) => {
        if (b.volume !== a.volume) return b.volume - a.volume;
        return b.revenue - a.revenue;
      })
      .slice(0, 5);

    // 4) SLA
    const slaDayMap = new Map();
    const ensureSlaDay = (dateKey) => {
      if (!slaDayMap.has(dateKey)) {
        slaDayMap.set(dateKey, { date: dateKey, early: 0, on_time: 0, late: 0, pending: 0 });
      }
      return slaDayMap.get(dateKey);
    };

    let slaEarly = 0,
      slaOnTime = 0,
      slaLate = 0,
      slaPending = 0,
      slaSkipped = 0;
    const slaDeltas = [];

    for (const r of rows) {
      if (!r.tgl_selesai) {
        slaSkipped++;
        continue;
      }

      const deadlineDateKey = toLocalDateKey(r.tgl_selesai);

      if (!r.pengantaran_at) {
        slaPending++;
        if (deadlineDateKey) ensureSlaDay(deadlineDateKey).pending++;
        continue;
      }

      const pengantaranDateKey = toLocalDateKey(r.pengantaran_at);
      const dp = parseDate(r.pengantaran_at);
      const dd = parseDate(r.tgl_selesai);
      if (dp && dd) slaDeltas.push((dp.getTime() - dd.getTime()) / 36e5);

      let cat;
      if (pengantaranDateKey < deadlineDateKey) {
        cat = "early";
        slaEarly++;
      } else if (pengantaranDateKey === deadlineDateKey) {
        cat = "on_time";
        slaOnTime++;
      } else {
        cat = "late";
        slaLate++;
      }

      if (deadlineDateKey) ensureSlaDay(deadlineDateKey)[cat]++;
    }

    const totalDeliveredSla = slaEarly + slaOnTime + slaLate;
    const slaRate = totalDeliveredSla > 0
      ? Number(((slaEarly + slaOnTime) / totalDeliveredSla * 100).toFixed(1))
      : null;
    const avgDeltaHours = slaDeltas.length > 0
      ? Number((slaDeltas.reduce((s, v) => s + v, 0) / slaDeltas.length).toFixed(2))
      : null;

    const slaInsights = {
      total_with_deadline: totalDeliveredSla + slaPending,
      total_delivered: totalDeliveredSla,
      early: slaEarly,
      on_time: slaOnTime,
      late: slaLate,
      pending: slaPending,
      skipped: slaSkipped,
      sla_rate: slaRate,
      avg_delta_hours: avgDeltaHours,
      distribution: Array.from(slaDayMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
      ),
    };

    return res.json({
      summary: list,
      overall,
      insights: {
        daily_stage: dailyStage,
        aging_processing_hours: agingProcessingHours,
        top_services: topServices,
        sla: slaInsights,
      },
    });
  } catch (err) {
    console.error("[kpiProduksi/getKpiSummary]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data KPI", error: err.message });
  }
};

/* ── KPI Detail — per employee ──────────────────────────── */
export const getKpiDetail = async (req, res) => {
  const { employee_name, date_start, date_end, date_field = "tgl_terima" } = req.query;

  if (!employee_name || !date_start || !date_end) {
    return res.status(400).json({ message: "employee_name, date_start, date_end wajib diisi" });
  }

  const dateFieldSafe = date_field === "tgl_selesai" ? "tgl_selesai" : "tgl_terima";

  try {
    const [rows] = await cleanoxPool.query(
      `SELECT
         id, no_nota, outlet, customer_nama, nama_item, jumlah, satuan_item,
         pickup_by, pickup_at,
         cuci_jemur_by, cuci_jemur_at,
         packing_by, packing_at,
         pengantaran_by, pengantaran_at,
         status, tgl_terima, tgl_selesai
       FROM ${TRANSAKSI_TABLE}
       WHERE DATE(${dateFieldSafe}) BETWEEN DATE(?) AND DATE(?)
         AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
           OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
         AND (
           JSON_CONTAINS(pickup_by,      JSON_QUOTE(?)) = 1
        OR JSON_CONTAINS(cuci_jemur_by,  JSON_QUOTE(?)) = 1
        OR JSON_CONTAINS(packing_by,     JSON_QUOTE(?)) = 1
        OR JSON_CONTAINS(pengantaran_by, JSON_QUOTE(?)) = 1
         )
       ORDER BY tgl_terima DESC`,
      [date_start, date_end, employee_name, employee_name, employee_name, employee_name]
    );

    const items = [];
    rows.forEach((r) => {
      const pd = parseJson(r.pickup_by);
      const cj = parseJson(r.cuci_jemur_by);
      const pk = parseJson(r.packing_by);
      const pg = parseJson(r.pengantaran_by);

      const base = {
        id: r.id,
        invoice: r.no_nota,
        outlet: r.outlet,
        customer_name: r.customer_nama,
        item_name: r.nama_item,
        jumlah: r.jumlah,
        satuan_item: r.satuan_item,
        status: r.status,
        tgl_terima: r.tgl_terima,
        tgl_selesai: r.tgl_selesai,
      };

      if (pd.includes(employee_name)) items.push({ ...base, stage: "pickup", date: r.pickup_at });
      if (cj.includes(employee_name)) items.push({ ...base, stage: "cuci_jemur", date: r.cuci_jemur_at });
      if (pk.includes(employee_name)) items.push({ ...base, stage: "packing", date: r.packing_at });
      if (pg.includes(employee_name)) items.push({ ...base, stage: "pengantaran", date: r.pengantaran_at });
    });

    return res.json({ employee_name, items });
  } catch (err) {
    console.error("[kpiProduksi/getKpiDetail]", err.message);
    return res.status(500).json({ message: "Gagal mengambil detail KPI", error: err.message });
  }
};

/* ── Available Periods ───────────────────────────────────── */
export const getAvailablePeriods = async (req, res) => {
  try {
    const [rows] = await cleanoxPool.query(
      `SELECT DISTINCT
         CASE
           WHEN DAY(tgl_terima) >= 26 THEN
             CASE WHEN MONTH(tgl_terima) = 12 THEN YEAR(tgl_terima) + 1 ELSE YEAR(tgl_terima) END
           ELSE YEAR(tgl_terima)
         END AS yr,
         CASE
           WHEN DAY(tgl_terima) >= 26 THEN
             CASE WHEN MONTH(tgl_terima) = 12 THEN 1 ELSE MONTH(tgl_terima) + 1 END
           ELSE MONTH(tgl_terima)
         END AS mo
       FROM ${TRANSAKSI_TABLE}
       WHERE tgl_terima IS NOT NULL
         AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
           OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
       ORDER BY yr DESC, mo DESC`
    );

    // Calculate current active period (Jakarta UTC+7)
    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const jktDate = now.getUTCDate();
    const jktMonth = now.getUTCMonth() + 1;
    const jktYear = now.getUTCFullYear();

    let activeMonth, activeYear;
    if (jktDate >= 26) {
      if (jktMonth === 12) {
        activeMonth = 1;
        activeYear = jktYear + 1;
      } else {
        activeMonth = jktMonth + 1;
        activeYear = jktYear;
      }
    } else {
      activeMonth = jktMonth;
      activeYear = jktYear;
    }

    const exists = rows.some((r) => Number(r.yr) === activeYear && Number(r.mo) === activeMonth);
    if (!exists) {
      rows.push({ yr: activeYear, mo: activeMonth });
      rows.sort((a, b) => b.yr - a.yr || b.mo - a.mo);
    }

    return res.json({ periods: rows });
  } catch (err) {
    console.error("[kpiProduksi/getAvailablePeriods]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data periode", error: err.message });
  }
};

/* ── Get Outlets — distinct outlets from transaksi ─────── */
export const getKpiOutlets = async (_req, res) => {
  try {
    const [rows] = await cleanoxPool.query(
      `SELECT DISTINCT outlet FROM ${TRANSAKSI_TABLE}
       WHERE outlet IS NOT NULL AND outlet != ''
         AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
           OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
       ORDER BY outlet ASC`
    );
    const outlets = rows.map((r) => r.outlet);
    return res.json({ outlets });
  } catch (err) {
    console.error("[kpiProduksi/getKpiOutlets]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data outlet", error: err.message });
  }
};

/* ── SLA Items — drill-down per category ─────────────────── */
export const getSlaItems = async (req, res) => {
  const { category, date_start, date_end, outlet, date_field = "tgl_terima" } = req.query;

  if (!category || !date_start || !date_end) {
    return res.status(400).json({ message: "category, date_start, date_end wajib diisi" });
  }

  const VALID_CATEGORIES = ["early", "on_time", "late", "pending", "skipped", "tepat", "terlambat", "total"];
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: "category tidak valid" });
  }

  const dateFieldSafe = date_field === "tgl_selesai" ? "tgl_selesai" : "tgl_terima";
  const outletWhere = outlet ? "AND outlet = ?" : "";
  const outletParams = outlet ? [outlet] : [];

  const categoryConditions = {
    early:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) < DATE(tgl_selesai)",
    on_time:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) = DATE(tgl_selesai)",
    late:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) > DATE(tgl_selesai)",
    pending:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NULL",
    skipped: "tgl_selesai IS NULL",
    tepat:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) <= DATE(tgl_selesai)",
    terlambat:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) > DATE(tgl_selesai)",
    total:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL"
  };

  try {
    const [rows] = await cleanoxPool.query(
      `SELECT id, no_nota, outlet, customer_nama, nama_item, jumlah, satuan_item,
              tgl_terima, tgl_selesai, pengantaran_at, cuci_jemur_deadline_at, status
       FROM ${TRANSAKSI_TABLE}
       WHERE DATE(${dateFieldSafe}) BETWEEN DATE(?) AND DATE(?)
         AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
           OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
         ${outletWhere}
         AND ${categoryConditions[category]}
       ORDER BY cuci_jemur_deadline_at ASC, tgl_terima ASC
       LIMIT 500`,
      [date_start, date_end, ...outletParams]
    );

    const items = rows.map(r => {
      let sla_status = "terlambat";
      if (r.pengantaran_at && r.tgl_selesai) {
        if (toLocalDateKey(r.pengantaran_at) <= toLocalDateKey(r.tgl_selesai)) {
          sla_status = "tepat";
        }
      }
      return {
        id: r.id,
        invoice: r.no_nota,
        outlet: r.outlet,
        customer_name: r.customer_nama,
        item_name: r.nama_item,
        jumlah: r.jumlah,
        satuan_item: r.satuan_item,
        received_date: r.tgl_terima,
        target_date: r.tgl_selesai,
        pengantaran_at: r.pengantaran_at,
        status: sla_status
      };
    });

    return res.json({ category, items });
  } catch (err) {
    console.error("[kpiProduksi/getSlaItems]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data SLA items", error: err.message });
  }
};

/* ── Export SLA Items — .xlsx ────────────────────────────── */
export const exportSlaItems = async (_req, res) => {
  const { category, date_start, date_end, outlet, date_field = "tgl_terima" } = _req.query;

  if (!category || !date_start || !date_end) {
    return res.status(400).json({ message: "category, date_start, date_end wajib diisi" });
  }

  const VALID_CATEGORIES = ["early", "on_time", "late", "pending", "skipped", "tepat", "terlambat", "total"];
  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ message: "category tidak valid" });
  }

  const CATEGORY_LABELS = {
    early: "Lebih Cepat",
    on_time: "Tepat Waktu",
    late: "Terlambat",
    pending: "Belum Diantar",
    skipped: "Tanpa Target",
    tepat: "Tepat Waktu",
    terlambat: "Terlambat",
    total: "Total Pengantaran"
  };

  const dateFieldSafe = date_field === "tgl_selesai" ? "tgl_selesai" : "tgl_terima";
  const outletWhere = outlet ? "AND outlet = ?" : "";
  const outletParams = outlet ? [outlet] : [];

  const categoryConditions = {
    early:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) < DATE(tgl_selesai)",
    on_time:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) = DATE(tgl_selesai)",
    late:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) > DATE(tgl_selesai)",
    pending:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NULL",
    skipped: "tgl_selesai IS NULL",
    tepat:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) <= DATE(tgl_selesai)",
    terlambat:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL AND DATE(pengantaran_at) > DATE(tgl_selesai)",
    total:
      "tgl_selesai IS NOT NULL AND NULLIF(TRIM(IFNULL(CAST(pengantaran_at AS CHAR),'')),''  ) IS NOT NULL"
  };

  const fmtDate = (v) => {
    if (!v) return "";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  };

  const deltaDays = (pengantaran, selesai) => {
    if (!pengantaran || !selesai) return null;
    const dp = new Date(pengantaran);
    const ds = new Date(selesai);
    if (Number.isNaN(dp.getTime()) || Number.isNaN(ds.getTime())) return null;
    const dpD = new Date(dp.getFullYear(), dp.getMonth(), dp.getDate());
    const dsD = new Date(ds.getFullYear(), ds.getMonth(), ds.getDate());
    return Math.round((dpD - dsD) / 864e5);
  };

  try {
    const [rows] = await cleanoxPool.query(
      `SELECT id, no_nota, outlet, customer_nama, nama_item, jumlah, satuan_item,
              tgl_terima, tgl_selesai, pengantaran_at, status
       FROM ${TRANSAKSI_TABLE}
       WHERE DATE(${dateFieldSafe}) BETWEEN DATE(?) AND DATE(?)
         AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
           OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
         ${outletWhere}
         AND ${categoryConditions[category]}
       ORDER BY tgl_terima ASC
       LIMIT 5000`,
      [date_start, date_end, ...outletParams]
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "Cleanox App";
    wb.created = new Date();

    const ws = wb.addWorksheet("SLA Items", { views: [{ state: "frozen", ySplit: 3 }] });

    const categoryLabel = CATEGORY_LABELS[category] || category;
    const outletLabel = outlet || "Semua Outlet";

    ws.mergeCells("A1:I1");
    const titleCell = ws.getCell("A1");
    titleCell.value = `Laporan SLA — ${categoryLabel}`;
    titleCell.font = { bold: true, size: 14, color: { argb: "FF1F3D6B" } };
    titleCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 28;

    ws.mergeCells("A2:I2");
    const subCell = ws.getCell("A2");
    subCell.value = `Periode: ${date_start} s/d ${date_end}  |  Outlet: ${outletLabel}  |  Total: ${rows.length} item`;
    subCell.font = { size: 10, color: { argb: "FF555555" } };
    subCell.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(2).height = 18;

    const headers = [
      { header: "No", key: "no", width: 5 },
      { header: "No Nota", key: "no_nota", width: 18 },
      { header: "Outlet", key: "outlet", width: 16 },
      { header: "Customer", key: "customer_nama", width: 22 },
      { header: "Item", key: "nama_item", width: 28 },
      { header: "Tgl Terima", key: "tgl_terima", width: 15 },
      { header: "Target Selesai", key: "tgl_selesai", width: 15 },
      { header: "Pengantaran", key: "pengantaran_at", width: 15 },
      { header: "Selisih (hari)", key: "selisih", width: 14 },
    ];

    ws.columns = headers;

    const headerRow = ws.getRow(3);
    headerRow.values = headers.map((h) => h.header);
    headerRow.height = 20;
    headerRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3D6B" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
      cell.border = {
        bottom: { style: "medium", color: { argb: "FF1F3D6B" } },
      };
    });

    rows.forEach((r, idx) => {
      const delta = deltaDays(r.pengantaran_at, r.tgl_selesai);
      const dataRow = ws.addRow([
        idx + 1,
        r.no_nota || "",
        r.outlet || "",
        r.customer_nama || "",
        r.nama_item || "",
        fmtDate(r.tgl_terima),
        fmtDate(r.tgl_selesai),
        r.pengantaran_at ? fmtDate(r.pengantaran_at) : "Belum",
        delta !== null ? delta : "",
      ]);

      dataRow.height = 16;
      dataRow.eachCell({ includeEmpty: true }, (cell, _colNumber) => {
        cell.font = { size: 9 };
        cell.alignment = { vertical: "middle", wrapText: false };
        if (idx % 2 === 1) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
        }
      });

      const selisihCell = dataRow.getCell(9);
      selisihCell.alignment = { horizontal: "center", vertical: "middle" };
      if (delta !== null) {
        if (delta < 0) {
          selisihCell.font = { size: 9, bold: true, color: { argb: "FF065F46" } };
          selisihCell.value = `${delta} hari`;
        } else if (delta === 0) {
          selisihCell.font = { size: 9, bold: true, color: { argb: "FF1E40AF" } };
          selisihCell.value = `${delta} hari`;
        } else {
          selisihCell.font = { size: 9, bold: true, color: { argb: "FF991B1B" } };
          selisihCell.value = `+${delta} hari`;
        }
      }

      dataRow.getCell(2).font = { size: 9, name: "Courier New" };
      dataRow.getCell(7).font = { size: 9, color: { argb: "FFB45309" }, bold: true };
    });

    ws.addRow([]);
    const sumRow = ws.addRow([`Total: ${rows.length} item`, "", "", "", "", "", "", "", ""]);
    sumRow.getCell(1).font = { bold: true, size: 9, color: { argb: "FF374151" } };
    sumRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };

    const safeCategory = categoryLabel.replace(/\s+/g, "_");
    const filename = `SLA_${safeCategory}_${date_start}_${date_end}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[kpiProduksi/exportSlaItems]", err.message);
    return res.status(500).json({ message: "Gagal generate export", error: err.message });
  }
};
