import { safeCleanoxQuery } from "../../db/pool.js";

// Mapping label ruko/outlet ke outlet_code standar POS
export const OUTLET_MAPPING = {
  "Citra Gran": "citra_gran",
  "Sentra Eropa": "kota_wisata",
  "Raffles Hills": "raffles_hills",
  "Legenda": "legenda_wisata",
  "Legenda Wisata": "legenda_wisata",
  "Canadian": "canadian",
};

export const normalizeOutletCode = (outletName) => {
  if (!outletName) return null;
  return OUTLET_MAPPING[outletName] || String(outletName).toLowerCase().replace(/\s+/g, "_");
};

// ═══════════════════════════════════════════════════════════════════════════
// MASTER STAFF WASCHEN
// ═══════════════════════════════════════════════════════════════════════════

export const getStaffList = async (req, res) => {
  try {
    const { is_active, outlet } = req.query;
    let sql = "SELECT * FROM mst_waschen_cross_sell_staff WHERE 1=1";
    const params = [];

    if (is_active !== undefined && is_active !== "") {
      sql += " AND is_active = ?";
      params.push(Number(is_active));
    }
    if (outlet) {
      sql += " AND outlet = ?";
      params.push(outlet);
    }

    sql += " ORDER BY is_active DESC, outlet ASC, name ASC";

    const [rows] = await safeCleanoxQuery(sql, params);
    return res.json({ staff: rows });
  } catch (err) {
    console.error("[crossSell/getStaffList]", err.message);
    return res.status(500).json({ message: "Gagal mengambil daftar staff", error: err.message });
  }
};

export const createStaff = async (req, res) => {
  try {
    const { name, position = "Frontliner", outlet, employee_id } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Nama staff wajib diisi" });
    }
    if (!outlet || !String(outlet).trim()) {
      return res.status(400).json({ message: "Ruko / outlet wajib dipilih" });
    }

    const trimmedName = String(name).trim();
    const trimmedOutlet = String(outlet).trim();
    const outletCode = normalizeOutletCode(trimmedOutlet);

    const [result] = await safeCleanoxQuery(
      `INSERT INTO mst_waschen_cross_sell_staff (name, position, outlet, outlet_code, employee_id, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [trimmedName, position, trimmedOutlet, outletCode, employee_id || null]
    );

    return res.status(201).json({
      message: "Staff berhasil ditambahkan",
      staff_id: result.insertId,
    });
  } catch (err) {
    console.error("[crossSell/createStaff]", err.message);
    return res.status(500).json({ message: "Gagal menambahkan staff", error: err.message });
  }
};

export const updateStaff = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, position, outlet } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Nama staff wajib diisi" });
    }
    if (!outlet || !String(outlet).trim()) {
      return res.status(400).json({ message: "Ruko / outlet wajib dipilih" });
    }

    const trimmedName = String(name).trim();
    const trimmedOutlet = String(outlet).trim();
    const outletCode = normalizeOutletCode(trimmedOutlet);

    await safeCleanoxQuery(
      `UPDATE mst_waschen_cross_sell_staff 
       SET name = ?, position = ?, outlet = ?, outlet_code = ?
       WHERE id = ?`,
      [trimmedName, position, trimmedOutlet, outletCode, id]
    );

    return res.json({ message: "Data staff berhasil diperbarui" });
  } catch (err) {
    console.error("[crossSell/updateStaff]", err.message);
    return res.status(500).json({ message: "Gagal memperbarui staff", error: err.message });
  }
};

export const toggleStaffStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    await safeCleanoxQuery(
      "UPDATE mst_waschen_cross_sell_staff SET is_active = ? WHERE id = ?",
      [Number(is_active) ? 1 : 0, id]
    );

    return res.json({
      message: Number(is_active) ? "Staff diaktifkan" : "Staff dinonaktifkan",
    });
  } catch (err) {
    console.error("[crossSell/toggleStaffStatus]", err.message);
    return res.status(500).json({ message: "Gagal mengubah status staff", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// TARGET KPI CONFIG
// ═══════════════════════════════════════════════════════════════════════════

export const getTargetConfig = async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    const [rows] = await safeCleanoxQuery(
      "SELECT target_per_staff FROM cfg_waschen_cross_sell_target WHERE year = ? AND month = ? LIMIT 1",
      [year, month]
    );

    const target = rows.length > 0 ? Number(rows[0].target_per_staff) : 10;
    return res.json({ year, month, target_per_staff: target });
  } catch (err) {
    console.error("[crossSell/getTargetConfig]", err.message);
    return res.status(500).json({ message: "Gagal mengambil target", error: err.message });
  }
};

export const saveTargetConfig = async (req, res) => {
  try {
    const { year, month, target_per_staff } = req.body;
    const y = Number(year);
    const m = Number(month);
    const t = Math.max(1, Number(target_per_staff || 10));

    if (!y || !m) {
      return res.status(400).json({ message: "Tahun dan bulan wajib disertakan" });
    }

    await safeCleanoxQuery(
      `INSERT INTO cfg_waschen_cross_sell_target (year, month, target_per_staff)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE target_per_staff = ?`,
      [y, m, t, t]
    );

    return res.json({ message: "Target berhasil disimpan", target_per_staff: t });
  } catch (err) {
    console.error("[crossSell/saveTargetConfig]", err.message);
    return res.status(500).json({ message: "Gagal menyimpan target", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// REKOMENDASI (DATA & INPUT)
// ═══════════════════════════════════════════════════════════════════════════

export const getRecommendations = async (req, res) => {
  try {
    const { year, month, outlet, staff_id, status, search } = req.query;

    let sql = `
      SELECT 
        r.*,
        c.id AS pos_customer_exists_id
      FROM tr_waschen_cross_sell r
      LEFT JOIN mst_customers c ON c.id = r.pos_customer_id
      WHERE 1=1
    `;
    const params = [];

    if (year && month) {
      sql += " AND YEAR(r.chat_date) = ? AND MONTH(r.chat_date) = ?";
      params.push(Number(year), Number(month));
    } else if (year) {
      sql += " AND YEAR(r.chat_date) = ?";
      params.push(Number(year));
    }

    if (outlet && outlet !== "all" && outlet !== "Semua cabang") {
      sql += " AND r.outlet = ?";
      params.push(outlet);
    }

    if (staff_id && staff_id !== "all" && staff_id !== "Semua staff") {
      sql += " AND r.staff_id = ?";
      params.push(Number(staff_id));
    }

    if (status && status !== "all" && status !== "Semua status") {
      sql += " AND r.follow_up_status = ?";
      params.push(status);
    }

    if (search && String(search).trim()) {
      const q = `%${String(search).trim()}%`;
      sql += " AND (r.customer_name LIKE ? OR r.customer_phone LIKE ? OR r.notes LIKE ?)";
      params.push(q, q, q);
    }

    sql += " ORDER BY r.chat_date DESC, r.id DESC";

    const [rows] = await safeCleanoxQuery(sql, params);

    const formatted = rows.map((row) => {
      let services = [];
      try {
        services = typeof row.interested_services === "string" 
          ? JSON.parse(row.interested_services) 
          : row.interested_services || [];
      } catch {
        services = [];
      }
      return {
        ...row,
        interested_services: services,
      };
    });

    return res.json({ recommendations: formatted, total: formatted.length });
  } catch (err) {
    console.error("[crossSell/getRecommendations]", err.message);
    return res.status(500).json({ message: "Gagal mengambil data rekomendasi", error: err.message });
  }
};

export const createRecommendation = async (req, res) => {
  try {
    const {
      chat_date,
      outlet,
      staff_id,
      customer_name,
      customer_phone,
      interested_services,
      notes,
    } = req.body;

    if (!chat_date) {
      return res.status(400).json({ message: "Tanggal chat ke Minox wajib diisi" });
    }
    if (!outlet) {
      return res.status(400).json({ message: "Cabang asal customer wajib dipilih" });
    }
    if (!staff_id) {
      return res.status(400).json({ message: "Staff yang merekomendasikan wajib dipilih" });
    }
    if (!customer_name || !String(customer_name).trim()) {
      return res.status(400).json({ message: "Nama customer wajib diisi" });
    }
    if (!customer_phone || !String(customer_phone).trim()) {
      return res.status(400).json({ message: "Nomor WA customer wajib diisi" });
    }

    const servicesArray = Array.isArray(interested_services) ? interested_services : [];
    if (!servicesArray.length) {
      return res.status(400).json({ message: "Pilih minimal 1 layanan yang diminati" });
    }

    // Ambil info staff
    const [staffRows] = await safeCleanoxQuery(
      "SELECT id, name, position, outlet FROM mst_waschen_cross_sell_staff WHERE id = ? LIMIT 1",
      [staff_id]
    );
    if (!staffRows.length) {
      return res.status(400).json({ message: "Staff tidak ditemukan" });
    }
    const staff = staffRows[0];
    const outletCode = normalizeOutletCode(outlet);

    // Bersihkan nomor WA
    let cleanPhone = String(customer_phone).trim();
    if (cleanPhone.startsWith("+")) cleanPhone = cleanPhone.slice(1).trim();

    // Cek apakah customer sudah ada di Cleanox POS mst_customers
    const [existingPosCustomer] = await safeCleanoxQuery(
      `SELECT id, name, phone FROM mst_customers 
       WHERE REPLACE(REPLACE(phone, '-', ''), ' ', '') = REPLACE(REPLACE(?, '-', ''), ' ', '')
       LIMIT 1`,
      [cleanPhone]
    );

    const posCustomerId = existingPosCustomer.length > 0 ? existingPosCustomer[0].id : null;
    const isInPos = posCustomerId ? 1 : 0;

    const [result] = await safeCleanoxQuery(
      `INSERT INTO tr_waschen_cross_sell (
        chat_date, outlet, outlet_code, staff_id, staff_name, staff_position,
        customer_name, customer_phone, interested_services, notes, follow_up_status,
        pos_customer_id, is_in_pos, pos_exported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'belum_dihubungi', ?, ?, ?)`,
      [
        chat_date,
        outlet,
        outletCode,
        staff.id,
        staff.name,
        staff.position,
        String(customer_name).trim(),
        cleanPhone,
        JSON.stringify(servicesArray),
        notes ? String(notes).trim() : null,
        posCustomerId,
        isInPos,
        posCustomerId ? new Date() : null,
      ]
    );

    return res.status(201).json({
      message: "Rekomendasi berhasil disimpan",
      id: result.insertId,
      is_in_pos: Boolean(isInPos),
    });
  } catch (err) {
    console.error("[crossSell/createRecommendation]", err.message);
    return res.status(500).json({ message: "Gagal menyimpan rekomendasi", error: err.message });
  }
};

export const updateRecommendation = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      chat_date,
      outlet,
      staff_id,
      customer_name,
      customer_phone,
      interested_services,
      notes,
      follow_up_status,
    } = req.body;

    const [staffRows] = await safeCleanoxQuery(
      "SELECT id, name, position FROM mst_waschen_cross_sell_staff WHERE id = ? LIMIT 1",
      [staff_id]
    );
    const staff = staffRows[0] || {};
    const outletCode = normalizeOutletCode(outlet);
    const servicesArray = Array.isArray(interested_services) ? interested_services : [];

    await safeCleanoxQuery(
      `UPDATE tr_waschen_cross_sell SET
        chat_date = ?,
        outlet = ?,
        outlet_code = ?,
        staff_id = ?,
        staff_name = COALESCE(?, staff_name),
        staff_position = COALESCE(?, staff_position),
        customer_name = ?,
        customer_phone = ?,
        interested_services = ?,
        notes = ?,
        follow_up_status = COALESCE(?, follow_up_status)
       WHERE id = ?`,
      [
        chat_date,
        outlet,
        outletCode,
        staff_id,
        staff.name || null,
        staff.position || null,
        String(customer_name).trim(),
        String(customer_phone).trim(),
        JSON.stringify(servicesArray),
        notes ? String(notes).trim() : null,
        follow_up_status || null,
        id,
      ]
    );

    return res.json({ message: "Data rekomendasi berhasil diperbarui" });
  } catch (err) {
    console.error("[crossSell/updateRecommendation]", err.message);
    return res.status(500).json({ message: "Gagal memperbarui rekomendasi", error: err.message });
  }
};

export const updateFollowUpStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { follow_up_status } = req.body;

    if (!follow_up_status) {
      return res.status(400).json({ message: "Status follow-up wajib diisi" });
    }

    await safeCleanoxQuery(
      "UPDATE tr_waschen_cross_sell SET follow_up_status = ? WHERE id = ?",
      [follow_up_status, id]
    );

    return res.json({ message: "Status follow-up berhasil diperbarui" });
  } catch (err) {
    console.error("[crossSell/updateFollowUpStatus]", err.message);
    return res.status(500).json({ message: "Gagal memperbarui status", error: err.message });
  }
};

export const deleteRecommendation = async (req, res) => {
  try {
    const { id } = req.params;
    await safeCleanoxQuery("DELETE FROM tr_waschen_cross_sell WHERE id = ?", [id]);
    return res.json({ message: "Rekomendasi berhasil dihapus" });
  } catch (err) {
    console.error("[crossSell/deleteRecommendation]", err.message);
    return res.status(500).json({ message: "Gagal menghapus rekomendasi", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// ACTION: TAMBAHKAN KE MASTER CUSTOMER CLEANX POS (mst_customers)
// ═══════════════════════════════════════════════════════════════════════════

export const exportCustomerToPos = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeCleanoxQuery(
      "SELECT * FROM tr_waschen_cross_sell WHERE id = ? LIMIT 1",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Data rekomendasi tidak ditemukan" });
    }

    const rec = rows[0];
    const cleanPhone = String(rec.customer_phone).trim();

    // 1. Cek apakah customer sudah ada di mst_customers
    const [existing] = await safeCleanoxQuery(
      `SELECT id, name, phone, referral_source_id FROM mst_customers 
       WHERE REPLACE(REPLACE(phone, '-', ''), ' ', '') = REPLACE(REPLACE(?, '-', ''), ' ', '')
       LIMIT 1`,
      [cleanPhone]
    );

    let customerId = null;
    let isAlreadyExisted = false;

    if (existing.length > 0) {
      customerId = existing[0].id;
      isAlreadyExisted = true;
      // Update data referral jika belum ada
      if (!existing[0].referral_source_id) {
        await safeCleanoxQuery(
          `UPDATE mst_customers 
           SET referral_source_id = 8, 
               referral_waschen_branch = COALESCE(referral_waschen_branch, ?), 
               referral_employee_name = COALESCE(referral_employee_name, ?)
           WHERE id = ?`,
          [rec.outlet_code || normalizeOutletCode(rec.outlet), rec.staff_name, customerId]
        );
      }
    } else {
      // 2. Buat customer baru di mst_customers POS Cleanox
      const outletCode = rec.outlet_code || normalizeOutletCode(rec.outlet);

      const [insertRes] = await safeCleanoxQuery(
        `INSERT INTO mst_customers (
          name,
          phone,
          referral_source_id,
          referral_waschen_branch,
          referral_employee_name,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, 8, ?, ?, 'Aktif', NOW(), NOW())`,
        [rec.customer_name, cleanPhone, outletCode, rec.staff_name]
      );
      customerId = insertRes.insertId;
    }

    // 3. Update status di tr_waschen_cross_sell
    await safeCleanoxQuery(
      `UPDATE tr_waschen_cross_sell 
       SET is_in_pos = 1, pos_customer_id = ?, pos_exported_at = NOW() 
       WHERE id = ?`,
      [customerId, id]
    );

    return res.json({
      message: isAlreadyExisted
        ? `Customer sudah terdaftar di POS (ID: #${customerId}), data referral telah ditautkan`
        : `Customer ${rec.customer_name} berhasil ditambahkan ke Master Customer Cleanox POS!`,
      customer_id: customerId,
      is_new: !isAlreadyExisted,
    });
  } catch (err) {
    console.error("[crossSell/exportCustomerToPos]", err.message);
    return res.status(500).json({ message: "Gagal menambahkan ke POS", error: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// REKAP KPI & PROGRES STAFF
// ═══════════════════════════════════════════════════════════════════════════

export const getKpiSummary = async (req, res) => {
  try {
    const now = new Date();
    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    // 1. Ambil target
    const [targetRows] = await safeCleanoxQuery(
      "SELECT target_per_staff FROM cfg_waschen_cross_sell_target WHERE year = ? AND month = ? LIMIT 1",
      [year, month]
    );
    const targetPerStaff = targetRows.length > 0 ? Number(targetRows[0].target_per_staff) : 10;

    // 2. Ambil semua staff Waschen aktif
    const [allStaff] = await safeCleanoxQuery(
      "SELECT * FROM mst_waschen_cross_sell_staff WHERE is_active = 1 ORDER BY outlet ASC, name ASC"
    );

    // 3. Ambil agregat rekomendasi bulan ini per staff
    const [staffRecRows] = await safeCleanoxQuery(
      `SELECT 
        staff_id,
        COUNT(*) AS total_rekomendasi,
        SUM(CASE WHEN follow_up_status = 'closing' THEN 1 ELSE 0 END) AS total_closing
       FROM tr_waschen_cross_sell
       WHERE YEAR(chat_date) = ? AND MONTH(chat_date) = ?
       GROUP BY staff_id`,
      [year, month]
    );

    const staffRecMap = new Map();
    for (const r of staffRecRows) {
      staffRecMap.set(Number(r.staff_id), {
        total_rekomendasi: Number(r.total_rekomendasi || 0),
        total_closing: Number(r.total_closing || 0),
      });
    }

    // Susun KPI per staff
    let totalRekomendasiAll = 0;
    let totalClosingAll = 0;
    let staffMencapaiTarget = 0;

    const staffKpiList = allStaff.map((staff) => {
      const stats = staffRecMap.get(Number(staff.id)) || { total_rekomendasi: 0, total_closing: 0 };
      const rec = stats.total_rekomendasi;
      const closing = stats.total_closing;
      const progressPercent = Math.min(100, Math.round((rec / targetPerStaff) * 100));
      const reached = rec >= targetPerStaff;
      const remaining = Math.max(0, targetPerStaff - rec);

      totalRekomendasiAll += rec;
      totalClosingAll += closing;
      if (reached) staffMencapaiTarget += 1;

      return {
        staff_id: staff.id,
        name: staff.name,
        position: staff.position,
        outlet: staff.outlet,
        rekomendasi: rec,
        target: targetPerStaff,
        progress_percent: progressPercent,
        is_reached: reached,
        remaining,
        closing,
      };
    });

    // 4. Rekap per cabang asal customer
    const [outletRecRows] = await safeCleanoxQuery(
      `SELECT 
        outlet,
        COUNT(*) AS total_rekomendasi,
        SUM(CASE WHEN follow_up_status = 'closing' THEN 1 ELSE 0 END) AS total_closing
       FROM tr_waschen_cross_sell
       WHERE YEAR(chat_date) = ? AND MONTH(chat_date) = ?
       GROUP BY outlet`,
      [year, month]
    );

    const outletRecMap = new Map();
    for (const r of outletRecRows) {
      outletRecMap.set(r.outlet, {
        rekomendasi: Number(r.total_rekomendasi || 0),
        closing: Number(r.total_closing || 0),
      });
    }

    // Cabang-cabang standar
    const standardOutlets = ["Sentra Eropa", "Legenda", "Raffles Hills", "Citra Gran", "Canadian"];
    const outletKpiList = standardOutlets.map((outletName) => {
      const activeStaffInOutlet = allStaff.filter((s) => s.outlet === outletName);
      const staffReachedInOutlet = staffKpiList.filter((s) => s.outlet === outletName && s.is_reached);
      const recStats = outletRecMap.get(outletName) || { rekomendasi: 0, closing: 0 };

      return {
        outlet: outletName,
        rekomendasi: recStats.rekomendasi,
        staff_aktif: activeStaffInOutlet.length,
        staff_tercapai: staffReachedInOutlet.length,
        closing: recStats.closing,
      };
    });

    // 5. Hitung sisa hari di bulan yang dipilih
    let sisaHariBulanIni = 0;
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year === currentYear && month === currentMonth) {
      const lastDayOfMonth = new Date(year, month, 0).getDate();
      const currentDay = now.getDate();
      sisaHariBulanIni = Math.max(0, lastDayOfMonth - currentDay);
    }

    const totalStaffCount = allStaff.length;
    const rataRataPerStaff = totalStaffCount > 0 ? (totalRekomendasiAll / totalStaffCount).toFixed(1) : "0,0";

    return res.json({
      year,
      month,
      target_per_staff: targetPerStaff,
      summary_cards: {
        staff_mencapai_target_label: `${staffMencapaiTarget}/${totalStaffCount}`,
        staff_mencapai_target_count: staffMencapaiTarget,
        total_staff_count: totalStaffCount,
        total_rekomendasi: totalRekomendasiAll,
        rata_rata_per_staff: rataRataPerStaff.replace(".", ","),
        total_closing: totalClosingAll,
        sisa_hari_bulan_ini: sisaHariBulanIni,
      },
      staff_kpi: staffKpiList,
      outlet_kpi: outletKpiList,
    });
  } catch (err) {
    console.error("[crossSell/getKpiSummary]", err.message);
    return res.status(500).json({ message: "Gagal menghitung rekap KPI", error: err.message });
  }
};

export const getStaffMonthProgress = async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date();
    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    const [staffRows] = await safeCleanoxQuery(
      "SELECT id, name, position, outlet FROM mst_waschen_cross_sell_staff WHERE id = ? LIMIT 1",
      [id]
    );
    if (!staffRows.length) {
      return res.status(404).json({ message: "Staff tidak ditemukan" });
    }
    const staff = staffRows[0];

    const [targetRows] = await safeCleanoxQuery(
      "SELECT target_per_staff FROM cfg_waschen_cross_sell_target WHERE year = ? AND month = ? LIMIT 1",
      [year, month]
    );
    const target = targetRows.length > 0 ? Number(targetRows[0].target_per_staff) : 10;

    const [countRows] = await safeCleanoxQuery(
      `SELECT COUNT(*) AS total
       FROM tr_waschen_cross_sell
       WHERE staff_id = ? AND YEAR(chat_date) = ? AND MONTH(chat_date) = ?`,
      [id, year, month]
    );
    const count = Number(countRows[0].total || 0);
    const progressPercent = Math.min(100, Math.round((count / target) * 100));
    const remaining = Math.max(0, target - count);

    return res.json({
      staff,
      year,
      month,
      count,
      target,
      progress_percent: progressPercent,
      remaining,
      is_reached: count >= target,
    });
  } catch (err) {
    console.error("[crossSell/getStaffMonthProgress]", err.message);
    return res.status(500).json({ message: "Gagal mengambil progres staff", error: err.message });
  }
};
