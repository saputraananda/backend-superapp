import { safeCleanoxQuery } from "../../db/pool.js";

export const AGING_CONFIG = {
  "FAST CLEAN KASUR": { label: "Fast Clean Kasur", days: 90, isCrossSelling: false },
  "BANTAL GULING": { label: "Bantal Guling", days: 90, isCrossSelling: false },
  "SAJADAH": { label: "Sajadah", days: 90, isCrossSelling: false },
  "STROLLER BAYI": { label: "Stroller Bayi", days: 90, isCrossSelling: false },
  "GENERAL CLEANING": { label: "General Cleaning", days: 90, isCrossSelling: false },
  "DEEP CLEAN KASUR": { label: "Deep Clean Kasur", days: 180, isCrossSelling: false },
  "DEEP CLEAN SOFA KURSI": { label: "Deep Clean Sofa Kursi", days: 180, isCrossSelling: false },
  "KARPET": { label: "Karpet", days: 180, isCrossSelling: false },
  "GORDYN DAN VITRASE": { label: "Gordyn dan Vitrase", days: 180, isCrossSelling: false },
  "HEADBOARD": { label: "Headboard", days: 180, isCrossSelling: false },
  "KURSI DAN INTERIOR MOBIL": { label: "Kursi dan Interior Mobil", days: 60, isCrossSelling: false },
  "SEPATU": { label: "Sepatu", days: 30, isCrossSelling: false },
  "TAS": { label: "Tas", days: 75, isCrossSelling: false },
  "KOPER": { label: "Koper", days: null, isCrossSelling: true },
};

export function classifyService(rawName) {
  const name = String(rawName || "").toUpperCase();

  if (name.includes("KOPER")) return "KOPER";
  if (name.includes("SEPATU")) return "SEPATU";
  if (name.includes("TAS")) return "TAS";
  if (
    name.includes("MOBIL") ||
    name.includes("PLAFON") ||
    name.includes("HEADLINER") ||
    name.includes("TRUNK") ||
    name.includes("INTERIOR")
  ) {
    return "KURSI DAN INTERIOR MOBIL";
  }
  if (name.includes("HEADBOARD") || name.includes("DIPAN")) return "HEADBOARD";
  if (name.includes("GORDYN") || name.includes("VITRASE")) return "GORDYN DAN VITRASE";
  if (name.includes("KARPET") || name.includes("CARPET")) return "KARPET";
  if (name.includes("STROLLER") || name.includes("BABY")) return "STROLLER BAYI";
  if (name.includes("SAJADAH")) return "SAJADAH";
  if (name.includes("GENERAL CLEANING") || name.includes("GC")) return "GENERAL CLEANING";
  if (name.includes("SOFA") || name.includes("KURSI")) return "DEEP CLEAN SOFA KURSI";
  if (name.includes("BANTAL") || name.includes("GULING")) return "BANTAL GULING";

  const isDeepClean =
    name.includes("DEEP CLEAN") ||
    name.includes("DEEPCLEAN") ||
    name.includes("DEEP_CLEAN") ||
    name.includes(" DC") ||
    name.includes("(DC)") ||
    name.includes("DC)");
  const isFastClean =
    name.includes("FAST CLEAN") ||
    name.includes("FASTCLEAN") ||
    name.includes("FAST_CLEAN") ||
    name.includes(" FC") ||
    name.includes("(FC)") ||
    name.includes("FC)");
  const isBedOrKasur =
    name.includes("BED") ||
    name.includes("KASUR") ||
    name.includes("MATRAS") ||
    name.includes("SPRINGBED") ||
    name.includes("TOPPER");

  if (isBedOrKasur) {
    if (isDeepClean) return "DEEP CLEAN KASUR";
    return "FAST CLEAN KASUR";
  }

  return null;
}

export function normalizePhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  } else if (digits.startsWith("8")) {
    digits = "628" + digits.slice(1);
  }
  return digits;
}

async function loadAllRawCompletedTransactions() {
  const sqlSmartlink = `
    SELECT 
      'smartlink' AS source_system,
      r.no_nota AS reference_no,
      r.customer_nama AS customer_name,
      r.customer_telepon AS customer_phone,
      r.alamat_customer AS customer_address,
      r.nama_item AS service_name,
      r.tgl_selesai AS tgl_selesai,
      r.outlet
    FROM cleanox_smartlink.rekap_transaksi_reguler r
    WHERE r.is_active = 1
      AND r.tgl_selesai IS NOT NULL
      AND r.customer_nama IS NOT NULL
      AND TRIM(r.customer_nama) <> ''
  `;

  const sqlPos = `
    SELECT 
      'pos' AS source_system,
      t.transaction_no AS reference_no,
      t.customer_name AS customer_name,
      t.customer_phone AS customer_phone,
      t.customer_address AS customer_address,
      COALESCE(s.name, 'Layanan POS') AS service_name,
      COALESCE(
        (SELECT MAX(completed_at) FROM tr_worker_assignments WHERE transaction_id = t.id),
        (SELECT MAX(pengantaran_at) FROM tr_takehome_progress WHERE transaction_id = t.id),
        t.service_date
      ) AS tgl_selesai,
      'Cleanox' AS outlet
    FROM tr_transactions t
    JOIN tr_transaction_items ti ON ti.transaction_id = t.id
    LEFT JOIN mst_services s ON s.id = ti.service_id
    WHERE t.status = 'Completed'
      AND t.customer_name IS NOT NULL
      AND TRIM(t.customer_name) <> ''
  `;

  const [[smartlinkRows], [posRows]] = await Promise.all([
    safeCleanoxQuery(sqlSmartlink),
    safeCleanoxQuery(sqlPos),
  ]);

  return [...(smartlinkRows || []), ...(posRows || [])];
}

function processAgingItems(rows) {
  const now = new Date();
  const customerMap = new Map();

  for (const row of rows) {
    const categoryKey = classifyService(row.service_name);
    if (!categoryKey) continue;

    const normPhone = normalizePhone(row.customer_phone);
    const normName = String(row.customer_name || "").trim().toLowerCase();
    const custKey = normPhone ? `phone_${normPhone}` : `name_${normName}`;
    const pairKey = `${custKey}__${categoryKey}`;

    const completedAt = new Date(row.tgl_selesai);
    if (Number.isNaN(completedAt.getTime())) continue;

    const existing = customerMap.get(pairKey);
    if (!existing || completedAt > existing.completedAtDate) {
      customerMap.set(pairKey, {
        customer_name: String(row.customer_name || "").trim(),
        customer_phone: row.customer_phone || "",
        normalized_phone: normPhone,
        customer_address: row.customer_address || "-",
        category_key: categoryKey,
        category_label: AGING_CONFIG[categoryKey].label,
        service_name: row.service_name,
        reference_no: row.reference_no,
        source_system: row.source_system,
        outlet: row.outlet || "Cleanox",
        tgl_selesai: row.tgl_selesai,
        completedAtDate: completedAt,
      });
    }
  }

  const items = [];
  let reminderCount = 0;
  let safeCount = 0;
  let crossSellingCount = 0;

  for (const item of customerMap.values()) {
    const cfg = AGING_CONFIG[item.category_key];
    const diffMs = now.getTime() - item.completedAtDate.getTime();
    const agingDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    let status = "safe";
    let daysDiff = 0;

    if (cfg.isCrossSelling) {
      status = "cross_selling";
      crossSellingCount += 1;
    } else if (agingDays >= cfg.days) {
      status = "reminder";
      daysDiff = agingDays - cfg.days;
      reminderCount += 1;
    } else {
      status = "safe";
      daysDiff = cfg.days - agingDays;
      safeCount += 1;
    }

    items.push({
      customer_name: item.customer_name,
      customer_phone: item.customer_phone,
      normalized_phone: item.normalized_phone,
      customer_address: item.customer_address,
      category_key: item.category_key,
      category_label: item.category_label,
      service_name: item.service_name,
      reference_no: item.reference_no,
      source_system: item.source_system,
      outlet: item.outlet,
      tgl_selesai: item.tgl_selesai,
      aging_days: agingDays,
      threshold_days: cfg.days,
      is_cross_selling: cfg.isCrossSelling,
      status,
      days_diff: daysDiff,
    });
  }

  return {
    items,
    stats: {
      total: items.length,
      reminder: reminderCount,
      safe: safeCount,
      crossSelling: crossSellingCount,
    },
  };
}

/**
 * GET /cleanox/customer-aging/categories
 */
export async function getCustomerAgingCategories(req, res) {
  try {
    const categories = Object.entries(AGING_CONFIG).map(([key, val]) => ({
      key,
      label: val.label,
      days: val.days,
      isCrossSelling: val.isCrossSelling,
    }));
    return res.json({ success: true, categories });
  } catch (err) {
    console.error("[getCustomerAgingCategories Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal memuat kategori aging" });
  }
}

/**
 * GET /cleanox/customer-aging/stats
 */
export async function getCustomerAgingStats(req, res) {
  try {
    const rows = await loadAllRawCompletedTransactions();
    const { stats } = processAgingItems(rows);
    return res.json({ success: true, stats });
  } catch (err) {
    console.error("[getCustomerAgingStats Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal memuat statistik aging" });
  }
}

/**
 * GET /cleanox/customer-aging
 */
export async function listCustomerAging(req, res) {
  try {
    const {
      search = "",
      status = "all",
      category = "all",
      sortBy = "aging_desc",
      page = "1",
      pageSize = "20",
    } = req.query;

    const rows = await loadAllRawCompletedTransactions();
    const { items: allItems, stats } = processAgingItems(rows);

    let filtered = allItems;

    // Filter status
    const statusLower = String(status || "all").trim().toLowerCase();
    if (statusLower && statusLower !== "all") {
      filtered = filtered.filter((i) => i.status === statusLower);
    }

    // Filter category
    const catUpper = String(category || "all").trim().toUpperCase();
    if (catUpper && catUpper !== "ALL") {
      filtered = filtered.filter((i) => i.category_key === catUpper);
    }

    // Filter search
    const query = String(search || "").trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((i) =>
        i.customer_name.toLowerCase().includes(query) ||
        i.customer_phone.includes(query) ||
        i.normalized_phone.includes(query) ||
        i.service_name.toLowerCase().includes(query) ||
        i.reference_no.toLowerCase().includes(query) ||
        i.outlet.toLowerCase().includes(query)
      );
    }

    // Sorting
    filtered.sort((a, b) => {
      if (sortBy === "aging_asc") {
        return a.aging_days - b.aging_days;
      }
      if (sortBy === "date_desc") {
        return new Date(b.tgl_selesai).getTime() - new Date(a.tgl_selesai).getTime();
      }
      if (sortBy === "date_asc") {
        return new Date(a.tgl_selesai).getTime() - new Date(b.tgl_selesai).getTime();
      }
      if (sortBy === "name_asc") {
        return a.customer_name.localeCompare(b.customer_name);
      }
      // default: aging_desc (highest aging / most overdue first)
      return b.aging_days - a.aging_days;
    });

    const totalRecords = filtered.length;
    let paginatedData = filtered;
    let currentPage = 1;
    let currentLimit = totalRecords;

    if (String(pageSize).toLowerCase() !== "all") {
      currentPage = Math.max(1, parseInt(page, 10) || 1);
      currentLimit = Math.max(1, parseInt(pageSize, 10) || 20);
      const offset = (currentPage - 1) * currentLimit;
      paginatedData = filtered.slice(offset, offset + currentLimit);
    }

    const totalPages = Math.ceil(totalRecords / (currentLimit || 1)) || 1;

    return res.json({
      success: true,
      data: paginatedData,
      pagination: {
        page: currentPage,
        pageSize: currentLimit,
        totalRecords,
        totalPages,
      },
      stats,
    });
  } catch (err) {
    console.error("[listCustomerAging Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal memuat data aging pelanggan" });
  }
}
