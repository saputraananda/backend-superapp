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

/** Cleanox Only KPI: only home_service | take_home (no all). */
const parseOnlyServiceMode = (raw) => {
  const mode = String(raw || "").trim();
  if (mode === "home_service" || mode === "take_home") return mode;
  return null;
};

const onlyServiceModeSql = (serviceMode) => {
  if (serviceMode === "take_home") {
    return { sql: " AND t.service_mode = 'take_home'", params: [] };
  }
  return {
    sql: " AND (t.service_mode = 'home_service' OR t.service_mode IS NULL OR t.service_mode = '')",
    params: [],
  };
};

const TARGET_HOURS_PER_MONTH = 208;
const DURATION_PICKUP_MENIT = 30;
const DURATION_PENGANTARAN_MENIT = 30;

async function loadServiceDurationMap() {
  try {
    const [rows] = await cleanoxPool.query(
      `SELECT id, name, durasi_cuci_menit, durasi_jemur_menit, durasi_packing_menit,
              durasi_blower_menit, total_durasi_kerja_menit, sla_hari, kategori_kpi
       FROM mst_services`
    );
    const map = new Map();
    for (const r of rows) {
      const rawName = String(r.name || "").trim().toLowerCase();
      const cleanName = rawName.replace(/\s*\([^)]*\)/g, "").trim();
      const data = {
        ...r,
        durasi_cuci_menit: Number(r.durasi_cuci_menit) || 0,
        durasi_jemur_menit: Number(r.durasi_jemur_menit) || 0,
        durasi_packing_menit: Number(r.durasi_packing_menit) || 0,
        durasi_blower_menit: Number(r.durasi_blower_menit) || 0,
        total_durasi_kerja_menit: Number(r.total_durasi_kerja_menit) || 0,
        sla_hari: Number(r.sla_hari) || 0,
      };
      map.set(rawName, data);
      if (cleanName && cleanName !== rawName && !map.has(cleanName)) {
        map.set(cleanName, data);
      }
    }
    return map;
  } catch (err) {
    console.error("[loadServiceDurationMap]", err.message);
    return new Map();
  }
}

function resolveItemDuration(itemName, serviceMap) {
  const raw = String(itemName || "").trim().toLowerCase();
  const clean = raw.replace(/\s*\([^)]*\)/g, "").replace(/- cleanox/gi, "").trim();

  if (serviceMap.has(raw)) return serviceMap.get(raw);
  if (clean && serviceMap.has(clean)) return serviceMap.get(clean);

  // Substring match
  for (const [k, v] of serviceMap.entries()) {
    if (k.length >= 4 && (clean.includes(k) || k.includes(clean))) {
      return v;
    }
  }

  // Token-based matching
  if (clean.includes("karpet") && clean.includes("tebal")) {
    const m = serviceMap.get("karpet tebal");
    if (m) return m;
  }
  if (clean.includes("karpet") && clean.includes("tipis")) {
    const m = serviceMap.get("karpet tipis");
    if (m) return m;
  }
  if (clean.includes("karpet")) {
    const m = serviceMap.get("karpet sedang") || serviceMap.get("carpet");
    if (m) return m;
  }
  if (clean.includes("bantal") && clean.includes("jumbo")) {
    const m = serviceMap.get("bantal jumbo");
    if (m) return m;
  }
  if (clean.includes("bantal") || clean.includes("guling")) {
    const m = serviceMap.get("bantal standar") || serviceMap.get("bantal guling");
    if (m) return m;
  }
  if (clean.includes("sepatu")) {
    const m = serviceMap.get("sepatu kain/standar") || serviceMap.get("sepatu kulit");
    if (m) return m;
  }
  if (clean.includes("stroller")) {
    const m = serviceMap.get("stroller bayi");
    if (m) return m;
  }
  if (clean.includes("koper")) {
    const m = serviceMap.get("koper");
    if (m) return m;
  }

  return {
    durasi_cuci_menit: 20,
    durasi_jemur_menit: 5,
    durasi_packing_menit: 10,
    durasi_blower_menit: 0,
    total_durasi_kerja_menit: 35,
    sla_hari: 3,
  };
}

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

    const serviceMap = await loadServiceDurationMap();

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
          pickup_minutes: 0,
          cuci_jemur_minutes: 0,
          packing_minutes: 0,
          pengantaran_minutes: 0,
          total_minutes: 0,
          total_hours: 0,
          target_hours: TARGET_HOURS_PER_MONTH,
          achievement_pct: 0,
        };
      }
      return empMap[name];
    };

    for (const r of rows) {
      const svc = resolveItemDuration(r.nama_item, serviceMap);
      const cuciJemurMins = (svc.durasi_cuci_menit || 0) + (svc.durasi_jemur_menit || 0) || (svc.total_durasi_kerja_menit || 30);
      const packingMins = svc.durasi_packing_menit || (svc.total_durasi_kerja_menit ? Math.round(svc.total_durasi_kerja_menit * 0.2) : 15);
      const pickupMins = DURATION_PICKUP_MENIT;
      const pengMins = DURATION_PENGANTARAN_MENIT;

      const stages = [
        { names: parseJson(r.pickup_by), key: "pickup", mins: pickupMins },
        { names: parseJson(r.cuci_jemur_by), key: "cuci_jemur", mins: cuciJemurMins },
        { names: parseJson(r.packing_by), key: "packing", mins: packingMins },
        { names: parseJson(r.pengantaran_by), key: "pengantaran", mins: pengMins },
      ];
      for (const { names, key, mins } of stages) {
        for (const name of names) {
          if (!name || name === "Admin") continue;
          const emp = ensure(name);
          emp[key] += 1;
          emp[`${key}_minutes`] += mins;
          emp.total_minutes += mins;
        }
      }
    }

    const list = Object.values(empMap).map((e) => {
      const totalHours = Number((e.total_minutes / 60).toFixed(2));
      const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));
      return {
        ...e,
        total: e.pickup + e.cuci_jemur + e.packing + e.pengantaran,
        total_minutes: Math.round(e.total_minutes),
        total_hours: totalHours,
        target_hours: TARGET_HOURS_PER_MONTH,
        achievement_pct: achievementPct,
      };
    });
    list.sort((a, b) => b.total_hours - a.total_hours || b.total - a.total);
    list.forEach((e, i) => {
      e.rank = i + 1;
    });

    const sumWorkingHours = list.reduce((sum, e) => sum + e.total_hours, 0);

    // Overall stats
    const overall = {
      total_items: rows.length,
      pickup_done: rows.filter((r) => parseJson(r.pickup_by).length > 0).length,
      cuci_jemur_done: rows.filter((r) => parseJson(r.cuci_jemur_by).length > 0).length,
      packing_done: rows.filter((r) => parseJson(r.packing_by).length > 0).length,
      pengantaran_done: rows.filter((r) => parseJson(r.pengantaran_by).length > 0).length,
      target_hours_per_worker: TARGET_HOURS_PER_MONTH,
      total_working_hours: Number(sumWorkingHours.toFixed(2)),
      avg_working_hours: list.length > 0 ? Number((sumWorkingHours / list.length).toFixed(2)) : 0,
      avg_achievement_pct: list.length > 0 ? Number(((sumWorkingHours / list.length / TARGET_HOURS_PER_MONTH) * 100).toFixed(1)) : 0,
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

    const topServiceMap = new Map();
    const ensureService = (serviceName) => {
      if (!topServiceMap.has(serviceName)) {
        topServiceMap.set(serviceName, {
          service_name: serviceName,
          volume: 0,
          revenue: 0,
          _cycle_sum: 0,
          _cycle_count: 0,
        });
      }
      return topServiceMap.get(serviceName);
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

    const topServices = Array.from(topServiceMap.values())
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

    const serviceMap = await loadServiceDurationMap();
    const items = [];
    rows.forEach((r) => {
      const pd = parseJson(r.pickup_by);
      const cj = parseJson(r.cuci_jemur_by);
      const pk = parseJson(r.packing_by);
      const pg = parseJson(r.pengantaran_by);

      const svc = resolveItemDuration(r.nama_item, serviceMap);
      const cuciJemurMins = (svc.durasi_cuci_menit || 0) + (svc.durasi_jemur_menit || 0) || (svc.total_durasi_kerja_menit || 30);
      const packingMins = svc.durasi_packing_menit || (svc.total_durasi_kerja_menit ? Math.round(svc.total_durasi_kerja_menit * 0.2) : 15);
      const pickupMins = DURATION_PICKUP_MENIT;
      const pengMins = DURATION_PENGANTARAN_MENIT;

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

      if (pd.includes(employee_name)) items.push({
        ...base,
        stage: "pickup",
        date: r.pickup_at,
        duration_minutes: pickupMins,
        duration_hours: Number((pickupMins / 60).toFixed(2)),
      });
      if (cj.includes(employee_name)) items.push({
        ...base,
        stage: "cuci_jemur",
        date: r.cuci_jemur_at,
        duration_minutes: cuciJemurMins,
        duration_hours: Number((cuciJemurMins / 60).toFixed(2)),
      });
      if (pk.includes(employee_name)) items.push({
        ...base,
        stage: "packing",
        date: r.packing_at,
        duration_minutes: packingMins,
        duration_hours: Number((packingMins / 60).toFixed(2)),
      });
      if (pg.includes(employee_name)) items.push({
        ...base,
        stage: "pengantaran",
        date: r.pengantaran_at,
        duration_minutes: pengMins,
        duration_hours: Number((pengMins / 60).toFixed(2)),
      });
    });

    const totalMinutes = items.reduce((s, it) => s + (it.duration_minutes || 0), 0);
    const totalHours = Number((totalMinutes / 60).toFixed(2));
    const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));

    return res.json({
      employee_name,
      total_items: items.length,
      total_minutes: totalMinutes,
      total_hours: totalHours,
      target_hours: TARGET_HOURS_PER_MONTH,
      achievement_pct: achievementPct,
      items,
    });
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

/* ── Cleanox Only — helpers ─────────────────────────────── */
const ONLY_KPI_KEYS = ["pickup", "cuci_jemur", "packing", "pengantaran"];

const getTakehomeStageBundle = (progressRow) => {
  if (!progressRow) {
    return {
      at: { pickup: null, cuci_jemur: null, packing: null, pengantaran: null },
      by: { pickup: [], cuci_jemur: [], packing: [], pengantaran: [] },
    };
  }

  const pengantaranAt = progressRow.pengantaran_at || progressRow.diantar_at || null;
  const pengantaranBy = [
    ...parseJson(progressRow.pengantaran_by),
    ...(progressRow.pengantaran_at ? [] : parseJson(progressRow.diantar_by)),
  ];

  return {
    at: {
      pickup: progressRow.diambil_at || null,
      cuci_jemur: progressRow.dicuci_at || null,
      packing: progressRow.packing_at || null,
      pengantaran: pengantaranAt,
    },
    by: {
      pickup: parseJson(progressRow.diambil_by),
      cuci_jemur: parseJson(progressRow.dicuci_by),
      packing: parseJson(progressRow.packing_by),
      pengantaran: pengantaranBy,
    },
  };
};

const getHomeServiceStageTimestamps = (assignmentRow) => {
  if (!assignmentRow) {
    return { pickup: null, cuci_jemur: null, packing: null, pengantaran: null };
  }
  const pickupAt = assignmentRow.arrival_at || assignmentRow.started_at || null;
  const pengantaranAt =
    assignmentRow.completed_at ||
    (assignmentRow.assignment_status === "Done" ? assignmentRow.updated_at || assignmentRow.completed_at : null);
  return {
    pickup: pickupAt,
    cuci_jemur: assignmentRow.before_photo_at || null,
    packing: assignmentRow.after_photo_at || null,
    pengantaran: pengantaranAt,
  };
};

const creditEmployeeStages = (empMap, names, key, mins = 0) => {
  for (const name of names) {
    if (!name || name === "Admin") continue;
    if (!empMap[name]) {
      empMap[name] = {
        name,
        pickup: 0,
        cuci_jemur: 0,
        packing: 0,
        pengantaran: 0,
        total: 0,
        pickup_minutes: 0,
        cuci_jemur_minutes: 0,
        packing_minutes: 0,
        pengantaran_minutes: 0,
        total_minutes: 0,
        total_hours: 0,
        target_hours: TARGET_HOURS_PER_MONTH,
        achievement_pct: 0,
      };
    }
    empMap[name][key] += 1;
    empMap[name][`${key}_minutes`] += mins;
    empMap[name].total_minutes += mins;
  }
};

const earliestAt = (values) => {
  let best = null;
  let bestTs = Infinity;
  for (const v of values) {
    const d = parseDate(v);
    if (!d) continue;
    const ts = d.getTime();
    if (ts < bestTs) {
      bestTs = ts;
      best = v;
    }
  }
  return best;
};

const latestAt = (values) => {
  let best = null;
  let bestTs = -Infinity;
  for (const v of values) {
    const d = parseDate(v);
    if (!d) continue;
    const ts = d.getTime();
    if (ts > bestTs) {
      bestTs = ts;
      best = v;
    }
  }
  return best;
};

/* ── Cleanox Only — Home Service per Layanan ────────────── */
const HOME_SERVICE_TOP_SERVICES_PER_WORKER = 3;

async function loadHomeServiceDoneData(dateStart, dateEnd) {
  const [rows] = await cleanoxPool.query(
    `SELECT a.transaction_id, a.employee_name, a.completed_at,
            t.transaction_no, t.customer_name, t.service_date, t.status
     FROM tr_worker_assignments a
     INNER JOIN tr_transactions t ON t.id = a.transaction_id
     WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
       AND t.status <> 'Cancelled'
       AND (t.service_mode = 'home_service' OR t.service_mode IS NULL OR t.service_mode = '')
       AND a.assignment_status = 'Done'`,
    [dateStart, dateEnd]
  );

  const seen = new Set();
  const assignments = [];
  const txById = new Map();
  for (const row of rows) {
    const name = String(row.employee_name || "").trim();
    if (!name || name === "Admin") continue;
    const tid = Number(row.transaction_id);
    const key = `${name}::${tid}`;
    if (!txById.has(tid)) {
      txById.set(tid, {
        transaction_no: row.transaction_no,
        customer_name: row.customer_name,
        service_date: row.service_date,
        status: row.status,
        team: [],
        _completedAts: [],
        completed_at: null,
      });
    }
    const tx = txById.get(tid);
    if (row.completed_at) tx._completedAts.push(row.completed_at);
    if (seen.has(key)) continue;
    seen.add(key);
    tx.team.push(name);
    assignments.push({ transaction_id: tid, employee_name: name });
  }

  for (const tx of txById.values()) {
    tx.completed_at = latestAt(tx._completedAts);
    delete tx._completedAts;
  }

  if (txById.size === 0) {
    return { assignments: [], items: [], txById: new Map() };
  }

  const [items] = await cleanoxPool.query(
    `SELECT i.id, i.transaction_id, i.line_total,
            COALESCE(s.name, 'Tanpa Nama Item') AS service_name
     FROM tr_transaction_items i
     LEFT JOIN mst_services s ON s.id = i.service_id
     WHERE i.transaction_id IN (?)`,
    [Array.from(txById.keys())]
  );

  return { assignments, items, txById };
}

async function buildHomeServiceLayananSummary({ assignments, items, txById }) {
  const serviceMap = await loadServiceDurationMap();
  const itemsByTx = new Map();
  for (const item of items) {
    const tid = Number(item.transaction_id);
    if (!itemsByTx.has(tid)) itemsByTx.set(tid, []);
    itemsByTx.get(tid).push(item);
  }

  const empMap = new Map();
  for (const a of assignments) {
    if (!empMap.has(a.employee_name)) {
      empMap.set(a.employee_name, {
        name: a.employee_name,
        total_layanan: 0,
        notaSet: new Set(),
        serviceCounts: new Map(),
        total_minutes: 0,
        total_hours: 0,
        target_hours: TARGET_HOURS_PER_MONTH,
        achievement_pct: 0,
      });
    }
    const emp = empMap.get(a.employee_name);
    const txItems = itemsByTx.get(a.transaction_id) || [];
    for (const item of txItems) {
      const serviceName = normalizeServiceName(item.service_name);
      const svc = resolveItemDuration(serviceName, serviceMap);
      const itemMins = svc.total_durasi_kerja_menit || 60;
      emp.total_layanan += 1;
      emp.total_minutes += itemMins;
      emp.serviceCounts.set(serviceName, (emp.serviceCounts.get(serviceName) || 0) + 1);
      emp.notaSet.add(a.transaction_id);
    }
  }

  const summary = Array.from(empMap.values())
    .map((e) => {
      const totalNota = e.notaSet.size;
      const topServices = Array.from(e.serviceCounts.entries())
        .map(([service_name, count]) => ({ service_name, count }))
        .sort((x, y) => y.count - x.count || x.service_name.localeCompare(y.service_name))
        .slice(0, HOME_SERVICE_TOP_SERVICES_PER_WORKER);
      const totalHours = Number((e.total_minutes / 60).toFixed(2));
      const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));
      return {
        name: e.name,
        total: e.total_layanan,
        total_layanan: e.total_layanan,
        total_nota: totalNota,
        avg_layanan_per_nota: totalNota > 0 ? Number((e.total_layanan / totalNota).toFixed(1)) : 0,
        total_minutes: Math.round(e.total_minutes),
        total_hours: totalHours,
        target_hours: TARGET_HOURS_PER_MONTH,
        achievement_pct: achievementPct,
        top_services: topServices,
      };
    })
    .sort((x, y) => y.total_hours - x.total_hours || y.total_layanan - x.total_layanan || x.name.localeCompare(y.name));
  summary.forEach((e, i) => {
    e.rank = i + 1;
  });

  const sumWorkingHours = summary.reduce((s, e) => s + e.total_hours, 0);
  const sumLayanan = summary.reduce((s, e) => s + e.total_layanan, 0);
  const overall = {
    total_layanan: items.length,
    total_nota: txById.size,
    active_workers: summary.length,
    avg_layanan_per_worker: summary.length > 0 ? Number((sumLayanan / summary.length).toFixed(1)) : 0,
    target_hours_per_worker: TARGET_HOURS_PER_MONTH,
    total_working_hours: Number(sumWorkingHours.toFixed(2)),
    avg_working_hours: summary.length > 0 ? Number((sumWorkingHours / summary.length).toFixed(2)) : 0,
    avg_achievement_pct: summary.length > 0 ? Number(((sumWorkingHours / summary.length / TARGET_HOURS_PER_MONTH) * 100).toFixed(1)) : 0,
  };

  const dailyMap = new Map();
  for (const [tid, tx] of txById.entries()) {
    const dateKey = toLocalDateKey(tx.service_date);
    if (!dateKey) continue;
    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, { date: dateKey, total_layanan: 0, total_nota: 0 });
    }
    const d = dailyMap.get(dateKey);
    d.total_layanan += (itemsByTx.get(tid) || []).length;
    d.total_nota += 1;
  }
  const dailyLayanan = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const topServiceMap = new Map();
  for (const item of items) {
    const serviceName = normalizeServiceName(item.service_name);
    if (!topServiceMap.has(serviceName)) {
      topServiceMap.set(serviceName, { service_name: serviceName, volume: 0, revenue: 0 });
    }
    const svc = topServiceMap.get(serviceName);
    svc.volume += 1;
    const rev = Number(item.line_total || 0);
    if (Number.isFinite(rev)) svc.revenue += rev;
  }
  const topServices = Array.from(topServiceMap.values())
    .map((s) => ({
      service_name: s.service_name,
      volume: s.volume,
      revenue: Math.round(s.revenue),
      avg_cycle_hours: null,
      cycle_sample_count: 0,
    }))
    .sort((a, b) => b.volume - a.volume || b.revenue - a.revenue)
    .slice(0, 5);

  return {
    metric: "layanan",
    summary,
    overall,
    insights: {
      daily_stage: [],
      daily_layanan: dailyLayanan,
      aging_processing_hours: [],
      top_services: topServices,
      sla: null,
    },
  };
}

async function buildHomeServiceLayananDetail(employeeName, { assignments, items, txById }) {
  const serviceMap = await loadServiceDurationMap();
  const itemsByTx = new Map();
  for (const item of items) {
    const tid = Number(item.transaction_id);
    if (!itemsByTx.has(tid)) itemsByTx.set(tid, []);
    itemsByTx.get(tid).push(item);
  }

  const result = [];
  for (const a of assignments) {
    if (a.employee_name !== employeeName) continue;
    const tx = txById.get(a.transaction_id);
    if (!tx) continue;
    for (const item of itemsByTx.get(a.transaction_id) || []) {
      const serviceName = normalizeServiceName(item.service_name);
      const svc = resolveItemDuration(serviceName, serviceMap);
      const itemMins = svc.total_durasi_kerja_menit || 60;
      result.push({
        transaction_item_id: item.id,
        transaction_id: a.transaction_id,
        invoice: tx.transaction_no,
        customer_name: tx.customer_name,
        service_name: serviceName,
        service_date: tx.service_date,
        completed_at: tx.completed_at,
        status: tx.status,
        team: tx.team,
        duration_minutes: itemMins,
        duration_hours: Number((itemMins / 60).toFixed(2)),
      });
    }
  }

  result.sort((x, y) => {
    const dx = parseDate(x.service_date)?.getTime() || 0;
    const dy = parseDate(y.service_date)?.getTime() || 0;
    if (dy !== dx) return dy - dx;
    return String(x.invoice || "").localeCompare(String(y.invoice || ""));
  });

  const totalMinutes = result.reduce((s, it) => s + (it.duration_minutes || 0), 0);
  const totalHours = Number((totalMinutes / 60).toFixed(2));
  const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));

  return {
    employee_name: employeeName,
    metric: "layanan",
    total_minutes: totalMinutes,
    total_hours: totalHours,
    target_hours: TARGET_HOURS_PER_MONTH,
    achievement_pct: achievementPct,
    items: result,
  };
}

/* ── Cleanox Only — Available Periods ───────────────────── */
export const getKpiOnlyAvailablePeriods = async (_req, res) => {
  try {
    const [rows] = await cleanoxPool.query(
      `SELECT DISTINCT
         CASE
           WHEN DAY(service_date) >= 26 THEN
             CASE WHEN MONTH(service_date) = 12 THEN YEAR(service_date) + 1 ELSE YEAR(service_date) END
           ELSE YEAR(service_date)
         END AS yr,
         CASE
           WHEN DAY(service_date) >= 26 THEN
             CASE WHEN MONTH(service_date) = 12 THEN 1 ELSE MONTH(service_date) + 1 END
           ELSE MONTH(service_date)
         END AS mo
       FROM tr_transactions
       WHERE service_date IS NOT NULL
         AND status <> 'Cancelled'
       ORDER BY yr DESC, mo DESC`
    );

    const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const jktDate = now.getUTCDate();
    const jktMonth = now.getUTCMonth() + 1;
    const jktYear = now.getUTCFullYear();

    let activeMonth;
    let activeYear;
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

    return res.json({
      periods: rows.map((r) => ({ yr: Number(r.yr), mo: Number(r.mo) })),
    });
  } catch (err) {
    console.error("[kpiProduksi/getKpiOnlyAvailablePeriods]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data periode Cleanox Only", error: err.message });
  }
};

/* ── Cleanox Only — Summary ─────────────────────────────── */
export const getKpiOnlySummary = async (req, res) => {
  const { date_start, date_end, service_mode: serviceModeRaw } = req.query;

  if (!date_start || !date_end) {
    return res.status(400).json({ message: "date_start dan date_end wajib diisi" });
  }

  const serviceMode = parseOnlyServiceMode(serviceModeRaw);
  if (!serviceMode) {
    return res.status(400).json({
      message: "service_mode harus home_service atau take_home",
    });
  }

  const modeFilter = onlyServiceModeSql(serviceMode);

  try {
    if (serviceMode === "home_service") {
      const data = await loadHomeServiceDoneData(date_start, date_end);
      const summary = await buildHomeServiceLayananSummary(data);
      return res.json(summary);
    }

    const [txRows] = await cleanoxPool.query(
      `SELECT t.id, t.transaction_no, t.customer_name, t.service_date, t.service_mode,
              t.status, t.final_amount
       FROM tr_transactions t
       WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
         AND t.status <> 'Cancelled'
         ${modeFilter.sql}`,
      [date_start, date_end, ...modeFilter.params]
    );

    const takehomeIds = txRows
      .filter((t) => String(t.service_mode || "home_service") === "take_home")
      .map((t) => Number(t.id));
    const homeIds = txRows
      .filter((t) => String(t.service_mode || "home_service") !== "take_home")
      .map((t) => Number(t.id));

    let progressRows = [];
    if (takehomeIds.length > 0) {
      const [rows] = await cleanoxPool.query(
        `SELECT * FROM tr_takehome_progress WHERE transaction_id IN (?)`,
        [takehomeIds]
      );
      progressRows = rows;
    }

    let assignmentRows = [];
    if (homeIds.length > 0) {
      const [rows] = await cleanoxPool.query(
        `SELECT id, transaction_id, employee_name, assignment_status,
                started_at, arrival_at, before_photo_at, after_photo_at, completed_at, updated_at
         FROM tr_worker_assignments
         WHERE transaction_id IN (?)
           AND assignment_status NOT IN ('Rejected', 'Cancelled', 'Replaced')`,
        [homeIds]
      );
      assignmentRows = rows;
    }

    const [itemRows] = await cleanoxPool.query(
      `SELECT i.transaction_id, i.line_total, COALESCE(s.name, 'Tanpa Nama Item') AS service_name
       FROM tr_transaction_items i
       INNER JOIN tr_transactions t ON t.id = i.transaction_id
       LEFT JOIN mst_services s ON s.id = i.service_id
       WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
         AND t.status <> 'Cancelled'
         ${modeFilter.sql}`,
      [date_start, date_end, ...modeFilter.params]
    );

    const progressByTx = new Map();
    for (const p of progressRows) {
      progressByTx.set(Number(p.transaction_id), p);
    }

    const assignmentsByTx = new Map();
    for (const a of assignmentRows) {
      const tid = Number(a.transaction_id);
      if (!assignmentsByTx.has(tid)) assignmentsByTx.set(tid, []);
      assignmentsByTx.get(tid).push(a);
    }

    const empMap = {};
    const overallDone = {
      pickup: 0,
      cuci_jemur: 0,
      packing: 0,
      pengantaran: 0,
    };
    const dailyMap = new Map();
    const pickupToCuci = [];
    const cuciToPacking = [];
    const packingToDelivery = [];
    const pickupToDelivery = [];
    const txStageAt = new Map();

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

    for (const tx of txRows) {
      const tid = Number(tx.id);
      const isTakeHome = String(tx.service_mode || "home_service") === "take_home";
      const stageFilled = {
        pickup: false,
        cuci_jemur: false,
        packing: false,
        pengantaran: false,
      };
      const stageAts = {
        pickup: null,
        cuci_jemur: null,
        packing: null,
        pengantaran: null,
      };

      if (isTakeHome) {
        const bundle = getTakehomeStageBundle(progressByTx.get(tid) || null);
        const txItems = itemRows.filter((it) => Number(it.transaction_id) === tid);
        let cuciJemurMins = 0;
        let packingMins = 0;
        for (const item of txItems) {
          const svc = resolveItemDuration(item.service_name, serviceMap);
          cuciJemurMins += (svc.durasi_cuci_menit || 0) + (svc.durasi_jemur_menit || 0) || (svc.total_durasi_kerja_menit || 30);
          packingMins += svc.durasi_packing_menit || 15;
        }
        if (cuciJemurMins === 0) cuciJemurMins = 30;
        if (packingMins === 0) packingMins = 15;

        const stageMins = {
          pickup: DURATION_PICKUP_MENIT,
          cuci_jemur: cuciJemurMins,
          packing: packingMins,
          pengantaran: DURATION_PENGANTARAN_MENIT,
        };

        for (const key of ONLY_KPI_KEYS) {
          if (bundle.at[key]) {
            stageFilled[key] = true;
            stageAts[key] = bundle.at[key];
            const dateKey = toLocalDateKey(bundle.at[key]);
            if (dateKey) {
              const d = ensureDaily(dateKey);
              d[key] += 1;
              d.total += 1;
            }
          }
          creditEmployeeStages(empMap, bundle.by[key], key, stageMins[key]);
        }
      } else {
        const assignments = assignmentsByTx.get(tid) || [];
        const pickupAts = [];
        const cuciAts = [];
        const packingAts = [];
        const pengAts = [];

        for (const a of assignments) {
          const ts = getHomeServiceStageTimestamps(a);
          const name = a.employee_name;
          for (const key of ONLY_KPI_KEYS) {
            if (!ts[key]) continue;
            stageFilled[key] = true;
            if (key === "pickup") pickupAts.push(ts[key]);
            if (key === "cuci_jemur") cuciAts.push(ts[key]);
            if (key === "packing") packingAts.push(ts[key]);
            if (key === "pengantaran") pengAts.push(ts[key]);
            creditEmployeeStages(empMap, [name], key, 30);
            const dateKey = toLocalDateKey(ts[key]);
            if (dateKey) {
              const d = ensureDaily(dateKey);
              d[key] += 1;
              d.total += 1;
            }
          }
        }

        stageAts.pickup = earliestAt(pickupAts);
        stageAts.cuci_jemur = earliestAt(cuciAts);
        stageAts.packing = earliestAt(packingAts);
        stageAts.pengantaran = latestAt(pengAts);
      }

      for (const key of ONLY_KPI_KEYS) {
        if (stageFilled[key]) overallDone[key] += 1;
      }

      txStageAt.set(tid, stageAts);

      const h1 = diffHours(stageAts.pickup, stageAts.cuci_jemur);
      const h2 = diffHours(stageAts.cuci_jemur, stageAts.packing);
      const h3 = diffHours(stageAts.packing, stageAts.pengantaran);
      const h4 = diffHours(stageAts.pickup, stageAts.pengantaran);
      if (h1 !== null) pickupToCuci.push(h1);
      if (h2 !== null) cuciToPacking.push(h2);
      if (h3 !== null) packingToDelivery.push(h3);
      if (h4 !== null) pickupToDelivery.push(h4);
    }

    const list = Object.values(empMap).map((e) => {
      const totalHours = Number((e.total_minutes / 60).toFixed(2));
      const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));
      return {
        ...e,
        total: e.pickup + e.cuci_jemur + e.packing + e.pengantaran,
        total_minutes: Math.round(e.total_minutes),
        total_hours: totalHours,
        target_hours: TARGET_HOURS_PER_MONTH,
        achievement_pct: achievementPct,
      };
    });
    list.sort((a, b) => b.total_hours - a.total_hours || b.total - a.total);
    list.forEach((e, i) => {
      e.rank = i + 1;
    });

    const sumWorkingHours = list.reduce((sum, e) => sum + e.total_hours, 0);

    const overall = {
      total_items: txRows.length,
      pickup_done: overallDone.pickup,
      cuci_jemur_done: overallDone.cuci_jemur,
      packing_done: overallDone.packing,
      pengantaran_done: overallDone.pengantaran,
      target_hours_per_worker: TARGET_HOURS_PER_MONTH,
      total_working_hours: Number(sumWorkingHours.toFixed(2)),
      avg_working_hours: list.length > 0 ? Number((sumWorkingHours / list.length).toFixed(2)) : 0,
      avg_achievement_pct: list.length > 0 ? Number(((sumWorkingHours / list.length / TARGET_HOURS_PER_MONTH) * 100).toFixed(1)) : 0,
    };

    const dailyStage = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    const agingProcessingHours = [
      { stage: "pickup_to_cuci_jemur", ...summarizeHours(pickupToCuci) },
      { stage: "cuci_jemur_to_packing", ...summarizeHours(cuciToPacking) },
      { stage: "packing_to_delivery", ...summarizeHours(packingToDelivery) },
      { stage: "pickup_to_delivery", ...summarizeHours(pickupToDelivery) },
    ].filter((a) => a.sample_count > 0);

    const serviceMap = new Map();
    for (const item of itemRows) {
      const serviceName = normalizeServiceName(item.service_name);
      if (!serviceMap.has(serviceName)) {
        serviceMap.set(serviceName, {
          service_name: serviceName,
          volume: 0,
          revenue: 0,
          _cycle_sum: 0,
          _cycle_count: 0,
        });
      }
      const svc = serviceMap.get(serviceName);
      svc.volume += 1;
      const rev = Number(item.line_total || 0);
      if (Number.isFinite(rev)) svc.revenue += rev;

      const stageAts = txStageAt.get(Number(item.transaction_id));
      if (stageAts) {
        const cycle = diffHours(stageAts.pickup, stageAts.pengantaran);
        if (cycle !== null) {
          svc._cycle_sum += cycle;
          svc._cycle_count += 1;
        }
      }
    }

    const topServices = Array.from(serviceMap.values())
      .map((s) => ({
        service_name: s.service_name,
        volume: s.volume,
        revenue: Math.round(s.revenue),
        avg_cycle_hours:
          s._cycle_count > 0 ? Number((s._cycle_sum / s._cycle_count).toFixed(2)) : null,
        cycle_sample_count: s._cycle_count,
      }))
      .sort((a, b) => {
        if (b.volume !== a.volume) return b.volume - a.volume;
        return b.revenue - a.revenue;
      })
      .slice(0, 5);

    return res.json({
      summary: list,
      overall,
      insights: {
        daily_stage: dailyStage,
        aging_processing_hours: agingProcessingHours,
        top_services: topServices,
        sla: null,
      },
    });
  } catch (err) {
    console.error("[kpiProduksi/getKpiOnlySummary]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data KPI Cleanox Only", error: err.message });
  }
};

/* ── Cleanox Only — Detail per employee ─────────────────── */
export const getKpiOnlyDetail = async (req, res) => {
  const { employee_name, date_start, date_end, service_mode: serviceModeRaw } = req.query;

  if (!employee_name || !date_start || !date_end) {
    return res.status(400).json({ message: "employee_name, date_start, date_end wajib diisi" });
  }

  const serviceMode = parseOnlyServiceMode(serviceModeRaw);
  if (!serviceMode) {
    return res.status(400).json({
      message: "service_mode harus home_service atau take_home",
    });
  }

  const modeFilter = onlyServiceModeSql(serviceMode);

  try {
    if (serviceMode === "home_service") {
      const data = await loadHomeServiceDoneData(date_start, date_end);
      const detail = await buildHomeServiceLayananDetail(employee_name, data);
      return res.json(detail);
    }

    const [txRows] = await cleanoxPool.query(
      `SELECT t.id, t.transaction_no, t.customer_name, t.service_date, t.service_mode, t.status
       FROM tr_transactions t
       WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
         AND t.status <> 'Cancelled'
         ${modeFilter.sql}`,
      [date_start, date_end, ...modeFilter.params]
    );

    if (txRows.length === 0) {
      return res.json({ employee_name, items: [], service_mode: serviceMode });
    }

    const txIds = txRows.map((t) => Number(t.id));
    const takehomeIds = txRows
      .filter((t) => String(t.service_mode || "home_service") === "take_home")
      .map((t) => Number(t.id));
    const homeIds = txRows
      .filter((t) => String(t.service_mode || "home_service") !== "take_home")
      .map((t) => Number(t.id));

    let progressRows = [];
    if (takehomeIds.length > 0) {
      const [rows] = await cleanoxPool.query(
        `SELECT * FROM tr_takehome_progress WHERE transaction_id IN (?)`,
        [takehomeIds]
      );
      progressRows = rows;
    }

    let assignmentRows = [];
    if (homeIds.length > 0) {
      const [rows] = await cleanoxPool.query(
        `SELECT id, transaction_id, employee_name, assignment_status,
                started_at, arrival_at, before_photo_at, after_photo_at, completed_at, updated_at
         FROM tr_worker_assignments
         WHERE transaction_id IN (?)
           AND assignment_status NOT IN ('Rejected', 'Cancelled', 'Replaced')`,
        [homeIds]
      );
      assignmentRows = rows;
    }

    const [itemRows] = await cleanoxPool.query(
      `SELECT i.transaction_id, COALESCE(s.name, 'Tanpa Nama Item') AS service_name
       FROM tr_transaction_items i
       LEFT JOIN mst_services s ON s.id = i.service_id
       WHERE i.transaction_id IN (?)`,
      [txIds]
    );

    const progressByTx = new Map();
    for (const p of progressRows) progressByTx.set(Number(p.transaction_id), p);

    const assignmentsByTx = new Map();
    for (const a of assignmentRows) {
      const tid = Number(a.transaction_id);
      if (!assignmentsByTx.has(tid)) assignmentsByTx.set(tid, []);
      assignmentsByTx.get(tid).push(a);
    }

    const itemNamesByTx = new Map();
    for (const item of itemRows) {
      const tid = Number(item.transaction_id);
      if (!itemNamesByTx.has(tid)) itemNamesByTx.set(tid, []);
      itemNamesByTx.get(tid).push(item.service_name);
    }

    const items = [];

    for (const tx of txRows) {
      const tid = Number(tx.id);
      const itemNameList = itemNamesByTx.get(tid) || [];
      const item_name =
        itemNameList.length > 0
          ? [...new Set(itemNameList.map(normalizeServiceName))].join(", ")
          : "Transaksi Cleanox Only";

      const base = {
        id: tx.id,
        invoice: tx.transaction_no,
        outlet: null,
        customer_name: tx.customer_name,
        item_name,
        jumlah: null,
        satuan_item: null,
        status: tx.status,
        tgl_terima: tx.service_date,
        tgl_selesai: null,
      };

      const isTakeHome = String(tx.service_mode || "home_service") === "take_home";

      if (isTakeHome) {
        const bundle = getTakehomeStageBundle(progressByTx.get(tid) || null);
        for (const key of ONLY_KPI_KEYS) {
          if (bundle.by[key].includes(employee_name)) {
            items.push({ ...base, stage: key, date: bundle.at[key] });
          }
        }
      } else {
        const assignments = (assignmentsByTx.get(tid) || []).filter(
          (a) => a.employee_name === employee_name
        );
        for (const a of assignments) {
          const ts = getHomeServiceStageTimestamps(a);
          for (const key of ONLY_KPI_KEYS) {
            if (ts[key]) {
              items.push({ ...base, stage: key, date: ts[key] });
            }
          }
        }
      }
    }

    items.sort((a, b) => {
      const da = parseDate(a.date)?.getTime() || 0;
      const db = parseDate(b.date)?.getTime() || 0;
      return db - da;
    });

    return res.json({ employee_name, items });
  } catch (err) {
    console.error("[kpiProduksi/getKpiOnlyDetail]", err.message);
    return res.status(500).json({ message: "Gagal mengambil detail KPI Cleanox Only", error: err.message });
  }
};

/* ── Export KPI Produksi — .xlsx (2 Sheet: Summary & Detail per Pekerja) ── */
export const exportKpiExcel = async (req, res) => {
  const {
    data_source = "waschen",
    service_mode = "home_service",
    date_start,
    date_end,
    outlet,
    date_field = "tgl_terima",
  } = req.query;

  if (!date_start || !date_end) {
    return res.status(400).json({ message: "date_start dan date_end wajib diisi" });
  }

  try {
    const serviceMap = await loadServiceDurationMap();
    const isWaschen = data_source !== "only";

    let summaryRows = [];
    const detailsByEmployee = new Map(); // employeeName -> array of items
    let sourceTitle = "";

    const fmtDate = (v) => {
      if (!v) return "-";
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return String(v);
      return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
    };

    if (isWaschen) {
      sourceTitle = "Cleanox by Waschen";
      const dateFieldSafe = date_field === "tgl_selesai" ? "tgl_selesai" : "tgl_terima";
      const outletWhere = outlet ? "AND outlet = ?" : "";
      const outletParams = outlet ? [outlet] : [];

      const [rows] = await cleanoxPool.query(
        `SELECT
           id, no_nota, outlet, customer_nama, nama_item, jumlah, satuan_item,
           COALESCE(total_tagihan, 0) AS total_tagihan,
           pickup_by, pickup_at,
           cuci_jemur_by, cuci_jemur_at,
           packing_by, packing_at,
           pengantaran_by, pengantaran_at,
           status, tgl_terima, tgl_selesai
         FROM ${TRANSAKSI_TABLE}
         WHERE DATE(${dateFieldSafe}) BETWEEN DATE(?) AND DATE(?)
           AND (LOWER(COALESCE(nama_item,'')) LIKE '%cleanox%'
             OR LOWER(COALESCE(nama_item,'')) LIKE '%karpet%')
           ${outletWhere}
         ORDER BY tgl_terima DESC`,
        [date_start, date_end, ...outletParams]
      );

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
            pickup_minutes: 0,
            cuci_jemur_minutes: 0,
            packing_minutes: 0,
            pengantaran_minutes: 0,
            total_minutes: 0,
            total_hours: 0,
            target_hours: TARGET_HOURS_PER_MONTH,
            achievement_pct: 0,
          };
          detailsByEmployee.set(name, []);
        }
        return empMap[name];
      };

      for (const r of rows) {
        const svc = resolveItemDuration(r.nama_item, serviceMap);
        const cuciJemurMins = (svc.durasi_cuci_menit || 0) + (svc.durasi_jemur_menit || 0) || (svc.total_durasi_kerja_menit || 30);
        const packingMins = svc.durasi_packing_menit || (svc.total_durasi_kerja_menit ? Math.round(svc.total_durasi_kerja_menit * 0.2) : 15);
        const pickupMins = DURATION_PICKUP_MENIT;
        const pengMins = DURATION_PENGANTARAN_MENIT;

        const stages = [
          { names: parseJson(r.pickup_by), key: "pickup", stageLabel: "Pickup", mins: pickupMins, dt: r.pickup_at || r.tgl_terima },
          { names: parseJson(r.cuci_jemur_by), key: "cuci_jemur", stageLabel: "Cuci & Jemur", mins: cuciJemurMins, dt: r.cuci_jemur_at || r.tgl_terima },
          { names: parseJson(r.packing_by), key: "packing", stageLabel: "Packing", mins: packingMins, dt: r.packing_at || r.tgl_terima },
          { names: parseJson(r.pengantaran_by), key: "pengantaran", stageLabel: "Pengantaran", mins: pengMins, dt: r.pengantaran_at || r.tgl_selesai || r.tgl_terima },
        ];

        for (const stg of stages) {
          for (const name of stg.names) {
            if (!name || name === "Admin") continue;
            const emp = ensure(name);
            emp[stg.key] += 1;
            emp.total += 1;
            emp[`${stg.key}_minutes`] += stg.mins;
            emp.total_minutes += stg.mins;

            detailsByEmployee.get(name).push({
              invoice: r.no_nota || "-",
              customer_name: r.customer_nama || "-",
              outlet: r.outlet || "-",
              item_name: r.nama_item || "-",
              stage: stg.stageLabel,
              date: stg.dt,
              duration_minutes: stg.mins,
              duration_hours: Number((stg.mins / 60).toFixed(2)),
              status: r.status || "Selesai",
            });
          }
        }
      }

      summaryRows = Object.values(empMap).map((e) => {
        const totalHours = Number((e.total_minutes / 60).toFixed(2));
        const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));
        return {
          ...e,
          total_hours: totalHours,
          achievement_pct: achievementPct,
        };
      }).sort((a, b) => b.total_hours - a.total_hours || b.total - a.total || a.name.localeCompare(b.name));

      summaryRows.forEach((e, idx) => { e.rank = idx + 1; });

    } else {
      // Cleanox Only
      if (service_mode === "home_service") {
        sourceTitle = "Cleanox Only (Home Service)";
        const rawHome = await loadHomeServiceDoneData(date_start, date_end);
        const homeSummary = await buildHomeServiceLayananSummary(rawHome);
        summaryRows = homeSummary.summary || [];

        for (const emp of summaryRows) {
          const empDetail = await buildHomeServiceLayananDetail(emp.name, rawHome);
          const mappedItems = (empDetail.items || []).map((it) => ({
            invoice: it.invoice || "-",
            customer_name: it.customer_name || "-",
            outlet: "Cleanox Home Service",
            item_name: it.service_name || "-",
            stage: "Home Service",
            date: it.service_date,
            duration_minutes: it.duration_minutes || 60,
            duration_hours: it.duration_hours || 1.0,
            status: it.status || "Completed",
          }));
          detailsByEmployee.set(emp.name, mappedItems);
        }
      } else {
        // take_home
        sourceTitle = "Cleanox Only (Take Home)";
        const modeFilter = onlyServiceModeSql("take_home");
        const [txRows] = await cleanoxPool.query(
          `SELECT t.id, t.transaction_no, t.customer_name, t.service_date, t.service_mode, t.status
           FROM tr_transactions t
           WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
             AND t.status <> 'Cancelled'
             ${modeFilter.sql}
           ORDER BY t.service_date DESC`,
          [date_start, date_end, ...modeFilter.params]
        );
        const takehomeIds = txRows.map((t) => Number(t.id));
        let progressRows = [];
        if (takehomeIds.length > 0) {
          const [prows] = await cleanoxPool.query(
            `SELECT * FROM tr_takehome_progress WHERE transaction_id IN (?)`,
            [takehomeIds]
          );
          progressRows = prows;
        }
        const progressByTx = new Map();
        for (const p of progressRows) progressByTx.set(Number(p.transaction_id), p);

        const [itemRows] = await cleanoxPool.query(
          `SELECT i.transaction_id, COALESCE(s.name, 'Tanpa Nama Item') AS service_name
           FROM tr_transaction_items i
           INNER JOIN tr_transactions t ON t.id = i.transaction_id
           LEFT JOIN mst_services s ON s.id = i.service_id
           WHERE DATE(t.service_date) BETWEEN DATE(?) AND DATE(?)
             AND t.status <> 'Cancelled'
             ${modeFilter.sql}`,
          [date_start, date_end, ...modeFilter.params]
        );
        const itemNamesByTx = new Map();
        for (const item of itemRows) {
          const tid = Number(item.transaction_id);
          if (!itemNamesByTx.has(tid)) itemNamesByTx.set(tid, []);
          itemNamesByTx.get(tid).push(item.service_name);
        }

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
              total_minutes: 0,
              total_hours: 0,
              target_hours: TARGET_HOURS_PER_MONTH,
              achievement_pct: 0,
            };
            detailsByEmployee.set(name, []);
          }
          return empMap[name];
        };

        for (const tx of txRows) {
          const tid = Number(tx.id);
          const bundle = getTakehomeStageBundle(progressByTx.get(tid) || null);
          const rawItems = itemNamesByTx.get(tid) || ["Take Home Service"];
          const itemName = [...new Set(rawItems.map(normalizeServiceName))].join(", ");
          const svc = resolveItemDuration(itemName, serviceMap);

          const stageInfo = [
            { key: "pickup", label: "Pickup", mins: DURATION_PICKUP_MENIT },
            { key: "cuci_jemur", label: "Cuci & Jemur", mins: (svc.durasi_cuci_menit || 0) + (svc.durasi_jemur_menit || 0) || (svc.total_durasi_kerja_menit || 30) },
            { key: "packing", label: "Packing", mins: svc.durasi_packing_menit || 15 },
            { key: "pengantaran", label: "Pengantaran", mins: DURATION_PENGANTARAN_MENIT },
          ];

          for (const stg of stageInfo) {
            const workers = bundle.by[stg.key] || [];
            const at = bundle.at[stg.key] || tx.service_date;
            for (const name of workers) {
              if (!name || name === "Admin") continue;
              const emp = ensure(name);
              emp[stg.key] += 1;
              emp.total += 1;
              emp.total_minutes += stg.mins;

              detailsByEmployee.get(name).push({
                invoice: tx.transaction_no || "-",
                customer_name: tx.customer_name || "-",
                outlet: "Take Home",
                item_name: itemName,
                stage: stg.label,
                date: at,
                duration_minutes: stg.mins,
                duration_hours: Number((stg.mins / 60).toFixed(2)),
                status: tx.status || "Selesai",
              });
            }
          }
        }

        summaryRows = Object.values(empMap).map((e) => {
          const totalHours = Number((e.total_minutes / 60).toFixed(2));
          const achievementPct = Number(((totalHours / TARGET_HOURS_PER_MONTH) * 100).toFixed(1));
          return {
            ...e,
            total_hours: totalHours,
            achievement_pct: achievementPct,
          };
        }).sort((a, b) => b.total_hours - a.total_hours || b.total - a.total || a.name.localeCompare(b.name));

        summaryRows.forEach((e, idx) => { e.rank = idx + 1; });
      }
    }

    // Sort items of each employee by date DESC
    for (const [, items] of detailsByEmployee.entries()) {
      items.sort((a, b) => {
        const da = parseDate(a.date)?.getTime() || 0;
        const db = parseDate(b.date)?.getTime() || 0;
        return db - da;
      });
    }

    // Create Excel Workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = "SuperApp Alora Group - Cleanox KPI";
    wb.created = new Date();

    // ─────────────────────────────────────────────────────────────
    // SHEET 1: SUMMARY KPI PEKERJA
    // ─────────────────────────────────────────────────────────────
    const wsSummary = wb.addWorksheet("Summary KPI Pekerja", {
      views: [{ state: "frozen", ySplit: 4 }],
    });

    const isShowStages = isWaschen || (!isWaschen && service_mode === "take_home");
    const lastSummaryColLetter = isShowStages ? "L" : "H";

    // Title & Subtitle
    wsSummary.mergeCells(`A1:${lastSummaryColLetter}1`);
    const sTitle = wsSummary.getCell("A1");
    sTitle.value = `RINGKASAN KPI PRODUKSI CLEANOX — ${sourceTitle.toUpperCase()}`;
    sTitle.font = { bold: true, size: 14, color: { argb: "FF1B3459" } };
    sTitle.alignment = { horizontal: "center", vertical: "middle" };
    wsSummary.getRow(1).height = 28;

    wsSummary.mergeCells(`A2:${lastSummaryColLetter}2`);
    const sSub = wsSummary.getCell("A2");
    const outletTxt = outlet ? `Outlet: ${outlet}` : "Semua Outlet";
    sSub.value = `Periode: ${fmtDate(date_start)} s/d ${fmtDate(date_end)}  |  ${outletTxt}  |  Target Bulanan: ${TARGET_HOURS_PER_MONTH} Jam / Pekerja  |  Total Pekerja: ${summaryRows.length} Orang`;
    sSub.font = { size: 10, color: { argb: "FF475569" }, italic: true };
    sSub.alignment = { horizontal: "center", vertical: "middle" };
    wsSummary.getRow(2).height = 20;

    wsSummary.getRow(3).height = 8; // spacer

    // Column Definitions for Sheet 1
    const summaryColumns = [
      { header: "Peringkat", key: "rank", width: 11 },
      { header: "Nama Pekerja", key: "name", width: 26 },
      { header: "Total Layanan", key: "total", width: 15 },
    ];
    if (isShowStages) {
      summaryColumns.push(
        { header: "Pickup", key: "pickup", width: 11 },
        { header: "Cuci & Jemur", key: "cuci_jemur", width: 14 },
        { header: "Packing", key: "packing", width: 11 },
        { header: "Pengantaran", key: "pengantaran", width: 14 }
      );
    }
    summaryColumns.push(
      { header: "Total Durasi (Mnt)", key: "total_minutes", width: 17 },
      { header: "Jam Kerja (Jam)", key: "total_hours", width: 16 },
      { header: "Target (Jam)", key: "target_hours", width: 14 },
      { header: "Capaian (%)", key: "achievement_pct", width: 14 },
      { header: "Status Capaian", key: "status_capaian", width: 24 }
    );

    wsSummary.columns = summaryColumns;

    const sHeaderRow = wsSummary.getRow(4);
    sHeaderRow.values = summaryColumns.map((c) => c.header);
    sHeaderRow.height = 24;
    sHeaderRow.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B3459" } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FFCBD5E1" } },
        bottom: { style: "medium", color: { argb: "FF0F172A" } },
        left: { style: "thin", color: { argb: "FFCBD5E1" } },
        right: { style: "thin", color: { argb: "FFCBD5E1" } },
      };
    });

    let totalItemsAll = 0;
    let totalMinutesAll = 0;
    let totalHoursAll = 0;

    summaryRows.forEach((emp, idx) => {
      totalItemsAll += (emp.total || 0);
      totalMinutesAll += (emp.total_minutes || 0);
      totalHoursAll += (emp.total_hours || 0);

      const achPct = emp.achievement_pct || 0;
      let statusText = "Perlu Ditingkatkan";
      let statusColor = "FFDC2626"; // red
      if (achPct >= 100) {
        statusText = "Mencapai Target (>=100%)";
        statusColor = "FF059669"; // green
      } else if (achPct >= 75) {
        statusText = "On Track (>=75%)";
        statusColor = "FF0D9488"; // teal
      } else if (achPct >= 50) {
        statusText = "Cukup (>=50%)";
        statusColor = "FFD97706"; // amber
      }

      const rowValues = [
        emp.rank || idx + 1,
        emp.name,
        emp.total || 0,
      ];
      if (isShowStages) {
        rowValues.push(
          emp.pickup || 0,
          emp.cuci_jemur || 0,
          emp.packing || 0,
          emp.pengantaran || 0
        );
      }
      rowValues.push(
        emp.total_minutes || 0,
        Number(emp.total_hours || 0).toFixed(1),
        TARGET_HOURS_PER_MONTH,
        `${achPct}%`,
        statusText
      );

      const dRow = wsSummary.addRow(rowValues);
      dRow.height = 20;

      dRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { size: 9.5 };
        cell.alignment = { vertical: "middle" };
        cell.border = {
          top: { style: "thin", color: { argb: "FFE2E8F0" } },
          bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
          left: { style: "thin", color: { argb: "FFE2E8F0" } },
          right: { style: "thin", color: { argb: "FFE2E8F0" } },
        };

        if (idx % 2 === 1) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
        }

        // Alignments
        if (colNumber === 1) cell.alignment = { horizontal: "center", vertical: "middle" };
        if (colNumber === 2) {
          cell.font = { bold: true, size: 9.5, color: { argb: "FF0F172A" } };
        }
        if (colNumber >= 3 && colNumber <= (isShowStages ? 7 : 3)) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
        }
        if (colNumber === (isShowStages ? 8 : 4) || colNumber === (isShowStages ? 9 : 5)) {
          cell.alignment = { horizontal: "right", vertical: "middle" };
          cell.font = { bold: true, size: 9.5, color: { argb: "FF1E3A8A" } };
        }
        if (colNumber === (isShowStages ? 10 : 6) || colNumber === (isShowStages ? 11 : 7)) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
        }
        if (colNumber === (isShowStages ? 12 : 8)) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.font = { bold: true, size: 9.5, color: { argb: statusColor } };
        }
      });
    });

    // Summary Total Row
    const avgHours = summaryRows.length > 0 ? (totalHoursAll / summaryRows.length).toFixed(1) : "0.0";
    const avgPct = summaryRows.length > 0 ? ((totalHoursAll / summaryRows.length / TARGET_HOURS_PER_MONTH) * 100).toFixed(1) : "0.0";

    const totalRowValues = [
      "TOTAL",
      `Rata-Rata (${summaryRows.length} Pekerja)`,
      totalItemsAll,
    ];
    if (isShowStages) {
      const sumPickup = summaryRows.reduce((s, r) => s + (r.pickup || 0), 0);
      const sumCuci = summaryRows.reduce((s, r) => s + (r.cuci_jemur || 0), 0);
      const sumPacking = summaryRows.reduce((s, r) => s + (r.packing || 0), 0);
      const sumPengantaran = summaryRows.reduce((s, r) => s + (r.pengantaran || 0), 0);
      totalRowValues.push(sumPickup, sumCuci, sumPacking, sumPengantaran);
    }
    totalRowValues.push(
      totalMinutesAll,
      totalHoursAll.toFixed(1),
      TARGET_HOURS_PER_MONTH,
      `${avgPct}%`,
      `Rata-rata: ${avgHours} Jam`
    );

    const totalRow = wsSummary.addRow(totalRowValues);
    totalRow.height = 24;
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      cell.font = { bold: true, size: 9.5, color: { argb: "FF0F172A" } };
      cell.border = {
        top: { style: "medium", color: { argb: "FF475569" } },
        bottom: { style: "double", color: { argb: "FF475569" } },
        left: { style: "thin", color: { argb: "FFCBD5E1" } },
        right: { style: "thin", color: { argb: "FFCBD5E1" } },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // ─────────────────────────────────────────────────────────────
    // SHEET 2: DETAIL PER PEKERJA (DIBAGI PER PEKERJA)
    // ─────────────────────────────────────────────────────────────
    const wsDetail = wb.addWorksheet("Detail per Pekerja", {
      views: [{ state: "frozen", ySplit: 4 }],
    });

    const detailColumns = [
      { header: "No", key: "no", width: 6 },
      { header: "Tanggal", key: "date", width: 14 },
      { header: "No Nota / Invoice", key: "invoice", width: 19 },
      { header: "Customer", key: "customer_name", width: 24 },
      { header: "Outlet / Tipe", key: "outlet", width: 18 },
      { header: "Layanan / Item", key: "item_name", width: 32 },
      { header: "Tahapan / Peran", key: "stage", width: 16 },
      { header: "Durasi (Mnt)", key: "duration_minutes", width: 14 },
      { header: "Durasi (Jam)", key: "duration_hours", width: 14 },
      { header: "Status", key: "status", width: 14 },
    ];
    wsDetail.columns = detailColumns;

    wsDetail.mergeCells("A1:J1");
    const dTitle = wsDetail.getCell("A1");
    dTitle.value = `DETAIL PEKERJAAN KPI PER PEKERJA — ${sourceTitle.toUpperCase()}`;
    dTitle.font = { bold: true, size: 14, color: { argb: "FF1B3459" } };
    dTitle.alignment = { horizontal: "center", vertical: "middle" };
    wsDetail.getRow(1).height = 28;

    wsDetail.mergeCells("A2:J2");
    const dSub = wsDetail.getCell("A2");
    dSub.value = `Periode: ${fmtDate(date_start)} s/d ${fmtDate(date_end)}  |  Pekerjaan dikelompokkan per pekerja  |  Target Standar: ${TARGET_HOURS_PER_MONTH} Jam / Bulan`;
    dSub.font = { size: 10, color: { argb: "FF475569" }, italic: true };
    dSub.alignment = { horizontal: "center", vertical: "middle" };
    wsDetail.getRow(2).height = 20;

    wsDetail.getRow(3).height = 8; // spacer

    let currentDetailRowIdx = 4;

    if (summaryRows.length === 0) {
      const emptyRow = wsDetail.addRow(["-", "-", "-", "Tidak ada data pengerjaan pada periode ini.", "-", "-", "-", "-", "-", "-"]);
      emptyRow.height = 24;
    } else {
      for (const emp of summaryRows) {
        const empItems = detailsByEmployee.get(emp.name) || [];
        const empHours = emp.total_hours != null ? Number(emp.total_hours).toFixed(1) : "0.0";
        const empAch = emp.achievement_pct != null ? emp.achievement_pct : 0;

        // 1. Worker Header Section Banner
        currentDetailRowIdx++;
        const bannerRow = wsDetail.addRow([
          `👤 PEKERJA: ${emp.name.toUpperCase()}   |   Total: ${empItems.length} Pekerjaan   |   Jam Kerja: ${empHours} Jam   |   Target: ${TARGET_HOURS_PER_MONTH} Jam   |   Capaian KPI: ${empAch}%`
        ]);
        bannerRow.height = 26;
        wsDetail.mergeCells(`A${currentDetailRowIdx}:J${currentDetailRowIdx}`);
        const bannerCell = wsDetail.getCell(`A${currentDetailRowIdx}`);
        bannerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1B3459" } };
        bannerCell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10.5 };
        bannerCell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
        bannerCell.border = {
          top: { style: "medium", color: { argb: "FF0F172A" } },
          bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
        };

        // 2. Worker Table Columns Header
        currentDetailRowIdx++;
        const colHeaderRow = wsDetail.addRow(detailColumns.map((c) => c.header));
        colHeaderRow.height = 20;
        colHeaderRow.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } }; // Slate 700
          cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 9 };
          cell.alignment = { horizontal: "center", vertical: "middle" };
          cell.border = {
            top: { style: "thin", color: { argb: "FF475569" } },
            bottom: { style: "medium", color: { argb: "FF1E293B" } },
            left: { style: "thin", color: { argb: "FF475569" } },
            right: { style: "thin", color: { argb: "FF475569" } },
          };
        });

        // 3. Worker Items Rows
        let empSumMinutes = 0;
        let empSumHours = 0;

        if (empItems.length === 0) {
          currentDetailRowIdx++;
          const noItemRow = wsDetail.addRow(["", "-", "-", "Belum ada rincian pengerjaan pada periode ini.", "-", "-", "-", "-", "-", "-"]);
          noItemRow.height = 18;
          noItemRow.eachCell((c) => {
            c.font = { italic: true, size: 9, color: { argb: "FF94A3B8" } };
            c.alignment = { vertical: "middle" };
          });
        } else {
          empItems.forEach((it, iIdx) => {
            empSumMinutes += (it.duration_minutes || 0);
            empSumHours += (it.duration_hours || 0);

            currentDetailRowIdx++;
            const itemRow = wsDetail.addRow([
              iIdx + 1,
              fmtDate(it.date),
              it.invoice || "-",
              it.customer_name || "-",
              it.outlet || "-",
              it.item_name || "-",
              it.stage || "-",
              it.duration_minutes || 0,
              it.duration_hours != null ? Number(it.duration_hours).toFixed(2) : "0.00",
              it.status || "-",
            ]);
            itemRow.height = 18;

            itemRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
              cell.font = { size: 9 };
              cell.alignment = { vertical: "middle" };
              cell.border = {
                top: { style: "thin", color: { argb: "FFE2E8F0" } },
                bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
                left: { style: "thin", color: { argb: "FFE2E8F0" } },
                right: { style: "thin", color: { argb: "FFE2E8F0" } },
              };

              if (iIdx % 2 === 1) {
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
              }

              if (colNumber === 1 || colNumber === 2 || colNumber === 7 || colNumber === 10) {
                cell.alignment = { horizontal: "center", vertical: "middle" };
              }
              if (colNumber === 3) {
                cell.font = { bold: true, size: 9, color: { argb: "FF0F172A" } };
              }
              if (colNumber === 8 || colNumber === 9) {
                cell.alignment = { horizontal: "right", vertical: "middle" };
                cell.font = { bold: true, size: 9, color: { argb: "FF1E3A8A" } };
              }
            });
          });
        }

        // 4. Worker Subtotal Row
        currentDetailRowIdx++;
        const subtotalRow = wsDetail.addRow([
          "",
          "",
          "",
          "",
          "",
          `Subtotal: ${emp.name}`,
          `${empItems.length} Item`,
          empSumMinutes,
          empSumHours.toFixed(2),
          `${empAch}% Target`,
        ]);
        subtotalRow.height = 20;
        subtotalRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } }; // Light Blue
          cell.font = { bold: true, size: 9, color: { argb: "FF1E3A8A" } };
          cell.border = {
            top: { style: "thin", color: { argb: "FF93C5FD" } },
            bottom: { style: "medium", color: { argb: "FF3B82F6" } },
            left: { style: "thin", color: { argb: "FFDBEAFE" } },
            right: { style: "thin", color: { argb: "FFDBEAFE" } },
          };
          if (colNumber >= 6) {
            cell.alignment = { horizontal: colNumber >= 8 ? "right" : "center", vertical: "middle" };
          }
        });

        // 5. Blank spacer row before next worker
        currentDetailRowIdx++;
        const spacer = wsDetail.addRow([]);
        spacer.height = 14;
      }
    }

    // Set HTTP Response Headers for file download
    const cleanSourceLabel = isWaschen ? "Waschen" : service_mode === "take_home" ? "Only_TakeHome" : "Only_HomeService";
    const filename = `KPI_Produksi_Cleanox_${cleanSourceLabel}_${date_start}_${date_end}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[kpiProduksi/exportKpiExcel]", err);
    if (!res.headersSent) {
      return res.status(500).json({ message: "Gagal mengekspor Excel KPI", error: err.message });
    }
  }
};

