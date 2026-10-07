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

export async function loadAgingConfigs() {
  try {
    const [rows] = await safeCleanoxQuery(
      "SELECT * FROM mst_service_aging_configs WHERE is_active = 1 ORDER BY is_cross_selling ASC, aging_days ASC"
    );
    if (rows && rows.length > 0) {
      const map = {};
      for (const r of rows) {
        map[r.category_key] = {
          id: r.id,
          key: r.category_key,
          label: r.category_name,
          days: r.is_cross_selling ? null : r.aging_days,
          isCrossSelling: Boolean(r.is_cross_selling),
          keywords: r.keywords
            ? r.keywords
                .split(",")
                .map((k) => k.trim().toUpperCase())
                .filter(Boolean)
            : [],
        };
      }
      return map;
    }
  } catch (err) {
    console.warn("[loadAgingConfigs Warning]:", err.message);
  }
  return AGING_CONFIG;
}

let tableInitialized = false;
async function ensureReminderTable() {
  if (tableInitialized) return;
  try {
    await safeCleanoxQuery(`
      CREATE TABLE IF NOT EXISTS tr_customer_aging_reminders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_phone VARCHAR(50) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        reference_no VARCHAR(100),
        category_key VARCHAR(100) NOT NULL,
        service_name VARCHAR(255),
        channel VARCHAR(50) DEFAULT 'WhatsApp',
        reminded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reminded_by VARCHAR(100),
        notes TEXT,
        INDEX idx_phone_cat (customer_phone, category_key),
        INDEX idx_ref_cat (reference_no, category_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    tableInitialized = true;
  } catch (err) {
    console.error("[ensureReminderTable Error]:", err);
  }
}

export function classifyService(rawName, customConfigs = null) {
  const name = String(rawName || "").toUpperCase();

  // If dynamic configs available, match keywords
  if (customConfigs) {
    for (const [key, cfg] of Object.entries(customConfigs)) {
      if (key === "FAST CLEAN KASUR" || key === "DEEP CLEAN KASUR") continue;
      if (Array.isArray(cfg.keywords)) {
        for (const kw of cfg.keywords) {
          if (name.includes(kw)) {
            return key;
          }
        }
      }
    }

    const isBedOrKasur =
      name.includes("BED") ||
      name.includes("KASUR") ||
      name.includes("MATRAS") ||
      name.includes("SPRINGBED") ||
      name.includes("TOPPER");

    if (isBedOrKasur) {
      const isDeepClean =
        name.includes("DEEP CLEAN") ||
        name.includes("DEEPCLEAN") ||
        name.includes("DEEP_CLEAN") ||
        name.includes(" DC") ||
        name.includes("(DC)") ||
        name.includes("DC)");
      if (isDeepClean && customConfigs["DEEP CLEAN KASUR"]) return "DEEP CLEAN KASUR";
      if (customConfigs["FAST CLEAN KASUR"]) return "FAST CLEAN KASUR";
    }
  }

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

async function loadReminderLogs() {
  await ensureReminderTable();
  try {
    const [rows] = await safeCleanoxQuery(`
      SELECT 
        customer_phone,
        reference_no,
        category_key,
        reminded_at,
        reminded_by,
        notes,
        channel
      FROM tr_customer_aging_reminders
      ORDER BY reminded_at DESC
    `);
    return rows || [];
  } catch (err) {
    console.error("[loadReminderLogs Error]:", err);
    return [];
  }
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

function processAgingItems(rows, reminderLogs = [], configs = AGING_CONFIG) {
  const now = new Date();
  const customerMap = new Map();

  // Index reminder logs
  const reminderMap = new Map();
  const reminderCounts = new Map();

  for (const log of reminderLogs) {
    const normPhone = normalizePhone(log.customer_phone);
    const key1 = normPhone ? `${normPhone}__${log.category_key}` : null;
    const key2 = log.reference_no ? `${log.reference_no}__${log.category_key}` : null;

    if (key1) {
      if (!reminderMap.has(key1)) reminderMap.set(key1, log);
      reminderCounts.set(key1, (reminderCounts.get(key1) || 0) + 1);
    }
    if (key2) {
      if (!reminderMap.has(key2)) reminderMap.set(key2, log);
      reminderCounts.set(key2, (reminderCounts.get(key2) || 0) + 1);
    }
  }

  for (const row of rows) {
    const categoryKey = classifyService(row.service_name, configs);
    if (!categoryKey) continue;

    const normPhone = normalizePhone(row.customer_phone);
    const normName = String(row.customer_name || "").trim().toLowerCase();
    const custKey = normPhone ? `phone_${normPhone}` : `name_${normName}`;
    const pairKey = `${custKey}__${categoryKey}`;

    const completedAt = new Date(row.tgl_selesai);
    if (Number.isNaN(completedAt.getTime())) continue;

    const existing = customerMap.get(pairKey);
    if (!existing || completedAt > existing.completedAtDate) {
      const cfg = configs[categoryKey] || { label: categoryKey, days: 90, isCrossSelling: false };
      customerMap.set(pairKey, {
        customer_name: String(row.customer_name || "").trim(),
        customer_phone: row.customer_phone || "",
        normalized_phone: normPhone,
        customer_address: row.customer_address || "-",
        category_key: categoryKey,
        category_label: cfg.label || categoryKey,
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
  let remindedTotalCount = 0;
  let unremindedCount = 0;

  for (const item of customerMap.values()) {
    const cfg = configs[item.category_key] || { label: item.category_key, days: 90, isCrossSelling: false };
    const diffMs = now.getTime() - item.completedAtDate.getTime();
    const agingDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

    let status = "safe";
    let daysDiff = 0;

    if (cfg.isCrossSelling) {
      status = "cross_selling";
      crossSellingCount += 1;
    } else if (cfg.days != null && agingDays >= cfg.days) {
      status = "reminder";
      daysDiff = agingDays - cfg.days;
      reminderCount += 1;
    } else {
      status = "safe";
      daysDiff = (cfg.days || 90) - agingDays;
      safeCount += 1;
    }

    // Check reminder log
    const matchKey1 = item.normalized_phone ? `${item.normalized_phone}__${item.category_key}` : null;
    const matchKey2 = item.reference_no ? `${item.reference_no}__${item.category_key}` : null;
    const remLog = (matchKey1 && reminderMap.get(matchKey1)) || (matchKey2 && reminderMap.get(matchKey2)) || null;

    const isReminded = Boolean(remLog);
    const remindedAt = remLog ? remLog.reminded_at : null;
    const remindedBy = remLog ? remLog.reminded_by : null;
    const reminderChannel = remLog ? remLog.channel : null;
    const countReminders = (matchKey1 && reminderCounts.get(matchKey1)) || (matchKey2 && reminderCounts.get(matchKey2)) || 0;

    if (isReminded) {
      remindedTotalCount += 1;
    } else if (status === "reminder") {
      unremindedCount += 1;
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
      is_reminded: isReminded,
      reminded_at: remindedAt,
      reminded_by: remindedBy,
      reminder_channel: reminderChannel,
      reminder_count: countReminders,
    });
  }

  return {
    items,
    stats: {
      total: items.length,
      reminder: reminderCount,
      safe: safeCount,
      crossSelling: crossSellingCount,
      reminded: remindedTotalCount,
      unreminded: unremindedCount,
    },
  };
}

/**
 * GET /cleanox/customer-aging/categories
 */
export async function getCustomerAgingCategories(req, res) {
  try {
    const configs = await loadAgingConfigs();
    const categories = Object.entries(configs).map(([key, val]) => ({
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
    const [rows, reminderLogs, configs] = await Promise.all([
      loadAllRawCompletedTransactions(),
      loadReminderLogs(),
      loadAgingConfigs(),
    ]);
    const { stats } = processAgingItems(rows, reminderLogs, configs);
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
      reminderStatus = "all", // all | unreminded | reminded
      sortBy = "aging_desc",
      page = "1",
      pageSize = "20",
    } = req.query;

    const [rows, reminderLogs, configs] = await Promise.all([
      loadAllRawCompletedTransactions(),
      loadReminderLogs(),
      loadAgingConfigs(),
    ]);
    const { items: allItems, stats } = processAgingItems(rows, reminderLogs, configs);

    let filtered = allItems;

    // Filter status aging
    const statusLower = String(status || "all").trim().toLowerCase();
    if (statusLower && statusLower !== "all") {
      filtered = filtered.filter((i) => i.status === statusLower);
    }

    // Filter reminder status follow-up
    const remStatus = String(reminderStatus || "all").trim().toLowerCase();
    if (remStatus === "unreminded") {
      filtered = filtered.filter((i) => !i.is_reminded);
    } else if (remStatus === "reminded") {
      filtered = filtered.filter((i) => i.is_reminded);
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

/**
 * POST /cleanox/customer-aging/remind
 */
export async function recordCustomerReminder(req, res) {
  try {
    await ensureReminderTable();
    const {
      customer_phone = "",
      customer_name = "",
      reference_no = "",
      category_key = "",
      service_name = "",
      channel = "WhatsApp",
      notes = "",
    } = req.body;

    const reminded_by = req.user?.name || req.body.reminded_by || "CS Cleanox";

    if (!category_key) {
      return res.status(400).json({ success: false, message: "category_key wajib diisi" });
    }

    const normPhone = normalizePhone(customer_phone);

    await safeCleanoxQuery(
      `INSERT INTO tr_customer_aging_reminders 
        (customer_phone, customer_name, reference_no, category_key, service_name, channel, reminded_at, reminded_by, notes)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [normPhone || customer_phone, customer_name, reference_no, category_key, service_name, channel, reminded_by, notes]
    );

    return res.json({
      success: true,
      message: "Reminder berhasil dicatat",
      data: {
        customer_phone,
        customer_name,
        category_key,
        reminded_at: new Date().toISOString(),
        reminded_by,
      },
    });
  } catch (err) {
    console.error("[recordCustomerReminder Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal mencatat reminder" });
  }
}

/**
 * POST /cleanox/customer-aging/unremind
 */
export async function cancelCustomerReminder(req, res) {
  try {
    await ensureReminderTable();
    const { customer_phone = "", category_key = "", reference_no = "" } = req.body;
    const normPhone = normalizePhone(customer_phone);

    await safeCleanoxQuery(
      `DELETE FROM tr_customer_aging_reminders 
       WHERE category_key = ? 
         AND (customer_phone = ? OR customer_phone = ? OR (reference_no IS NOT NULL AND reference_no = ?))`,
      [category_key, normPhone, customer_phone, reference_no]
    );

    return res.json({ success: true, message: "Status reminder berhasil direset" });
  } catch (err) {
    console.error("[cancelCustomerReminder Error]:", err);
    return res.status(500).json({ success: false, message: "Gagal mereset status reminder" });
  }
}
