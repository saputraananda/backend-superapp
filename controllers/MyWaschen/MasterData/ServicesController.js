import { safeMyWaschenQuery } from "../../../db/pool.js";

async function fetchServiceInventory(serviceId) {
  const [rows] = await safeMyWaschenQuery(
    `SELECT si.id, si.service_id, si.item_id, si.qty_per_service, si.notes, si.is_active,
            i.code AS item_code, i.name AS item_name, u.symbol AS item_unit
     FROM mst_service_inventory si
     JOIN mst_inventory_item i ON i.id = si.item_id
     LEFT JOIN mst_unit u ON u.id = i.unit_id
     WHERE si.service_id = ? AND si.is_active = 1
     ORDER BY i.name ASC`,
    [serviceId]
  );
  return rows;
}

function parseDcPriceAdd(isRequired, raw) {
  if (Number(isRequired) === 1) return null;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function normalizeInventoryLines(rawLines) {
  if (!Array.isArray(rawLines)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const line of rawLines) {
    const itemId = Number(line.item_id);
    const qty = Number(line.qty_per_service);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    if (seen.has(itemId)) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    seen.add(itemId);
    cleaned.push({
      item_id: itemId,
      qty_per_service: qty,
      notes: line.notes?.trim() || null,
    });
  }
  return cleaned;
}

async function syncServiceInventory(serviceId, rawLines) {
  const lines = normalizeInventoryLines(rawLines);
  await safeMyWaschenQuery("DELETE FROM mst_service_inventory WHERE service_id = ?", [serviceId]);
  for (const line of lines) {
    const [item] = await safeMyWaschenQuery(
      "SELECT id FROM mst_inventory_item WHERE id = ? AND is_active = 1 LIMIT 1",
      [line.item_id]
    );
    if (!item.length) continue;
    await safeMyWaschenQuery(
      `INSERT INTO mst_service_inventory (service_id, item_id, qty_per_service, notes, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [serviceId, line.item_id, line.qty_per_service, line.notes]
    );
  }
}

// ── Layanan per outlet (mst_service_outlet) ──
// Satu baris = layanan tersedia di outlet. Kolom override NULL = ikut master.

/** Daftar id outlet valid dari body. undefined = tidak dikirim (jangan ubah). */
function parseOutletIds(raw) {
  if (!Array.isArray(raw)) return undefined;
  return [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/** Aktifkan layanan di outlet terpilih; outlet lain yang tidak dipilih dinonaktifkan (nilai custom tetap disimpan). */
async function syncServiceOutlets(serviceId, outletIds) {
  if (outletIds === undefined) return;
  for (const outletId of outletIds) {
    await safeMyWaschenQuery(
      `INSERT INTO mst_service_outlet (service_id, outlet_id, is_active) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [serviceId, outletId]
    );
  }
  // Outlet yang tidak dipilih tetap punya baris (is_active = 0) agar status "tidak tersedia" tercatat.
  await safeMyWaschenQuery(
    `INSERT INTO mst_service_outlet (service_id, outlet_id, is_active)
     SELECT ?, id, 0 FROM mst_outlet ${outletIds.length ? "WHERE id NOT IN (?)" : ""}
     ON DUPLICATE KEY UPDATE is_active = 0`,
    outletIds.length ? [serviceId, outletIds] : [serviceId]
  );
}

/** "" / null / undefined = ikut master (NULL). Angka tidak valid / negatif = error. */
function overrideNumber(raw, label) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: `${label} tidak valid` };
  return { value: n };
}

function overrideText(raw) {
  const s = raw == null ? "" : String(raw).trim();
  return s ? s : null;
}

// ── Helper: kode otomatis, sama dengan seed agent/addLayanan.js ──
// WS-KG (kategori KILOAN) · WS-ADD (kategori non-produksi) · WS-MTR (unit m², id 10) · WS-SAT (lainnya)
const generateNextServiceCode = async (categoryId, unitId) => {
  const [cat] = await safeMyWaschenQuery(
    "SELECT code, is_production FROM mst_service_category WHERE id = ? LIMIT 1",
    [categoryId]
  );
  const c = cat[0] || {};
  const prefix = c.code === "KILOAN" ? "KG" : Number(c.is_production) === 0 ? "ADD" : Number(unitId) === 10 ? "MTR" : "SAT";
  const [rows] = await safeMyWaschenQuery(
    `SELECT MAX(CAST(SUBSTRING_INDEX(code, '-', -1) AS UNSIGNED)) AS n FROM mst_service WHERE code LIKE ?`,
    [`WS-${prefix}-%`]
  );
  return `WS-${prefix}-${String((Number(rows[0]?.n) || 0) + 1).padStart(3, "0")}`;
};

// ── 1. GET LIST ──
// Durasi 0 hari valid (tidak boleh diam-diam jadi 2); hanya kosong/tidak valid yang default 2.
const durationDays = (v) => {
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) || n < 0 ? 2.0 : n;
};

export const getServices = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const unitId = req.query.unitId ? Number(req.query.unitId) : null;
    const isActive = req.query.isActive;
    const isFeatured = req.query.isFeatured;
    const sortBy = ["s.id", "code", "name", "price", "category_id", "regular_duration_days", "created_at"].includes(req.query.sortBy)
      ? req.query.sortBy
      : "s.id";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(s.code LIKE ? OR s.name LIKE ? OR s.description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (categoryId) {
      where.push("s.category_id = ?");
      params.push(categoryId);
    }

    if (unitId) {
      where.push("s.unit_id = ?");
      params.push(unitId);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("s.is_active = ?");
      params.push(Number(isActive));
    }

    if (isFeatured !== undefined && isFeatured !== "") {
      where.push("s.is_featured = ?");
      params.push(Number(isFeatured));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, c.name AS category_name, c.code AS category_code,
              u.name AS unit_name_full, u.symbol AS unit_symbol, u.code AS unit_code,
              (SELECT COUNT(*) FROM mst_service_inventory si
               WHERE si.service_id = s.id AND si.is_active = 1) AS inventory_item_count,
              (SELECT COUNT(*) FROM mst_service_outlet so
               WHERE so.service_id = s.id AND so.is_active = 1) AS outlet_count,
              (SELECT COUNT(*) FROM mst_service_outlet so
               WHERE so.service_id = s.id AND so.is_active = 1
                 AND (so.name IS NOT NULL OR so.category_id IS NOT NULL OR so.unit_id IS NOT NULL OR so.unit IS NOT NULL
                      OR so.price IS NOT NULL OR so.regular_duration_days IS NOT NULL
                      OR so.min_order_qty IS NOT NULL OR so.dc_price_add IS NOT NULL)) AS custom_outlet_count
       FROM mst_service s
       LEFT JOIN mst_service_category c ON s.category_id = c.id
       LEFT JOIN mst_unit u ON s.unit_id = u.id
       ${whereSql}
       ORDER BY ${sortBy} ${sortDir}`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getServices error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 2. GET BY ID ──
export const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*, c.name AS category_name, c.code AS category_code,
              u.name AS unit_name_full, u.symbol AS unit_symbol, u.code AS unit_code
       FROM mst_service s
       LEFT JOIN mst_service_category c ON s.category_id = c.id
       LEFT JOIN mst_unit u ON s.unit_id = u.id
       WHERE s.id = ?`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }
    const inventory_items = await fetchServiceInventory(id);
    const [outletRows] = await safeMyWaschenQuery(
      "SELECT outlet_id FROM mst_service_outlet WHERE service_id = ? AND is_active = 1",
      [id]
    );
    const outlet_ids = outletRows.map((r) => Number(r.outlet_id));
    res.json({ success: true, data: { ...rows[0], inventory_items, outlet_ids } });
  } catch (err) {
    console.error("getServiceById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 3. CREATE ──
export const createService = async (req, res) => {
  try {
    const { category_id, unit_id, code, name, unit, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active, is_dc_required, dc_price_add, inventory_items } = req.body;

    if (!category_id || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kategori dan Nama Layanan wajib diisi" });
    }
    const dcRequired = Number(is_dc_required) === 1 ? 1 : 0;

    const formattedCode = code?.trim()
      ? code.trim().toUpperCase()
      : await generateNextServiceCode(category_id, unit_id || 8);

    // Check duplicate code
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode layanan "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_service (category_id, unit_id, unit, code, name, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active, is_dc_required, dc_price_add)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(category_id),
        unit_id ? Number(unit_id) : 8,
        unit?.trim() || "Kg",
        formattedCode,
        name.trim(),
        Number(price) || 0,
        durationDays(regular_duration_days),
        Number(min_order_qty) || 1.0,
        description?.trim() || null,
        is_cleanox !== undefined ? Number(is_cleanox) : 0,
        is_featured !== undefined ? Number(is_featured) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        dcRequired,
        parseDcPriceAdd(dcRequired, dc_price_add)
      ]
    );

    await syncServiceInventory(result.insertId, inventory_items);

    // Outlet yang memakai layanan ini. Tidak dikirim = semua outlet (termasuk drop point).
    let outletIds = parseOutletIds(req.body.outlet_ids);
    if (outletIds === undefined) {
      const [allOutlets] = await safeMyWaschenQuery("SELECT id FROM mst_outlet");
      outletIds = allOutlets.map((r) => Number(r.id));
    }
    await syncServiceOutlets(result.insertId, outletIds);

    res.status(201).json({
      success: true,
      message: "Layanan berhasil ditambahkan",
      id: result.insertId,
      code: formattedCode
    });
  } catch (err) {
    console.error("createService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 4. UPDATE ──
export const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id, unit_id, code, name, unit, price, regular_duration_days, min_order_qty, description, is_cleanox, is_featured, is_active, is_dc_required, dc_price_add, inventory_items } = req.body;
    const dcRequired = Number(is_dc_required) === 1 ? 1 : 0;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Layanan wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase() : null;

    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode layanan "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_service
       SET category_id = COALESCE(?, category_id),
           unit_id = ?,
           unit = ?,
           code = COALESCE(?, code),
           name = ?,
           price = ?,
           regular_duration_days = ?,
           min_order_qty = ?,
           description = ?,
           is_cleanox = ?,
           is_featured = ?,
           is_active = ?,
           is_dc_required = ?,
           dc_price_add = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        category_id ? Number(category_id) : null,
        unit_id ? Number(unit_id) : 8,
        unit?.trim() || "Kg",
        formattedCode,
        name.trim(),
        Number(price) || 0,
        durationDays(regular_duration_days),
        Number(min_order_qty) || 1.0,
        description?.trim() || null,
        is_cleanox !== undefined ? Number(is_cleanox) : 0,
        is_featured !== undefined ? Number(is_featured) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        dcRequired,
        parseDcPriceAdd(dcRequired, dc_price_add),
        id
      ]
    );

    await syncServiceInventory(id, inventory_items);
    await syncServiceOutlets(Number(id), parseOutletIds(req.body.outlet_ids));

    res.json({ success: true, message: "Layanan berhasil diperbarui" });
  } catch (err) {
    console.error("updateService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 5. DELETE ──
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_service_inventory WHERE service_id = ?", [id]);
    await safeMyWaschenQuery("DELETE FROM mst_service_outlet WHERE service_id = ?", [id]);
    await safeMyWaschenQuery("DELETE FROM mst_service WHERE id = ?", [id]);
    res.json({ success: true, message: "Layanan berhasil dihapus" });
  } catch (err) {
    console.error("deleteService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 6. LAYANAN PER OUTLET: daftar semua master + status & nilai di outlet ──
export const getOutletServices = async (req, res) => {
  try {
    const outletId = Number(req.params.outletId);
    const [outlet] = await safeMyWaschenQuery(
      "SELECT id, outlet_code, name, full_name, COALESCE(is_drop_point, 0) AS is_drop_point FROM mst_outlet WHERE id = ?",
      [outletId]
    );
    if (!outlet.length) return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });

    const search = String(req.query.search || "").trim();
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const available = req.query.available;
    const where = [];
    const params = [outletId];
    if (search) {
      where.push("(s.code LIKE ? OR s.name LIKE ? OR so.name LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    if (categoryId) {
      where.push("COALESCE(so.category_id, s.category_id) = ?");
      params.push(categoryId);
    }
    if (available === "1") where.push("(so.id IS NOT NULL AND so.is_active = 1)");
    if (available === "0") where.push("(so.id IS NULL OR so.is_active = 0)");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT s.id, s.code, s.is_active AS master_active, s.is_cleanox, s.is_featured, s.is_dc_required,
              s.name AS master_name, s.category_id AS master_category_id, mc.name AS master_category_name,
              s.unit_id AS master_unit_id, COALESCE(s.unit, mu.symbol) AS master_unit,
              s.price AS master_price, s.regular_duration_days AS master_duration_days,
              s.min_order_qty AS master_min_order_qty, s.dc_price_add AS master_dc_price_add,
              so.id AS outlet_row_id, COALESCE(so.is_active, 0) AS outlet_active,
              so.name AS override_name, so.category_id AS override_category_id, so.unit_id AS override_unit_id,
              so.unit AS override_unit, so.price AS override_price,
              so.regular_duration_days AS override_duration_days, so.min_order_qty AS override_min_order_qty,
              so.dc_price_add AS override_dc_price_add,
              COALESCE(so.name, s.name) AS name,
              COALESCE(so.category_id, s.category_id) AS category_id, ec.name AS category_name,
              COALESCE(so.unit, s.unit, eu.symbol) AS unit,
              COALESCE(so.price, s.price) AS price,
              COALESCE(so.regular_duration_days, s.regular_duration_days) AS regular_duration_days,
              COALESCE(so.min_order_qty, s.min_order_qty) AS min_order_qty,
              COALESCE(so.dc_price_add, s.dc_price_add) AS dc_price_add
       FROM mst_service s
       LEFT JOIN mst_service_outlet so ON so.service_id = s.id AND so.outlet_id = ?
       LEFT JOIN mst_service_category mc ON mc.id = s.category_id
       LEFT JOIN mst_unit mu ON mu.id = s.unit_id
       LEFT JOIN mst_service_category ec ON ec.id = COALESCE(so.category_id, s.category_id)
       LEFT JOIN mst_unit eu ON eu.id = COALESCE(so.unit_id, s.unit_id)
       ${whereSql}
       ORDER BY s.id ASC`,
      params
    );

    res.json({ success: true, outlet: outlet[0], data: rows });
  } catch (err) {
    console.error("getOutletServices error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 7. SIMPAN NILAI CUSTOM LAYANAN DI 1 OUTLET (kosong = ikut master) ──
export const upsertOutletService = async (req, res) => {
  try {
    const serviceId = Number(req.params.id);
    const outletId = Number(req.params.outletId);
    const [svc] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id = ?", [serviceId]);
    if (!svc.length) return res.status(404).json({ success: false, message: "Layanan tidak ditemukan" });
    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });

    const b = req.body || {};
    const price = overrideNumber(b.price, "Tarif");
    const duration = overrideNumber(b.regular_duration_days, "Durasi");
    const minOrder = overrideNumber(b.min_order_qty, "Min. order");
    const dcAdd = overrideNumber(b.dc_price_add, "Tambahan DC");
    const bad = [price, duration, minOrder, dcAdd].find((r) => r.error);
    if (bad) return res.status(400).json({ success: false, message: bad.error });
    if (minOrder.value !== null && minOrder.value <= 0) {
      return res.status(400).json({ success: false, message: "Min. order harus lebih dari 0" });
    }

    const categoryId = b.category_id ? Number(b.category_id) : null;
    if (categoryId) {
      const [cat] = await safeMyWaschenQuery("SELECT id FROM mst_service_category WHERE id = ?", [categoryId]);
      if (!cat.length) return res.status(400).json({ success: false, message: "Kategori tidak ditemukan" });
    }
    const unitId = b.unit_id ? Number(b.unit_id) : null;
    const isActive = b.is_active === undefined ? 1 : Number(b.is_active) === 1 ? 1 : 0;

    await safeMyWaschenQuery(
      `INSERT INTO mst_service_outlet
         (service_id, outlet_id, name, category_id, unit_id, unit, price, regular_duration_days, min_order_qty, dc_price_add, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), category_id = VALUES(category_id), unit_id = VALUES(unit_id), unit = VALUES(unit),
         price = VALUES(price), regular_duration_days = VALUES(regular_duration_days),
         min_order_qty = VALUES(min_order_qty), dc_price_add = VALUES(dc_price_add), is_active = VALUES(is_active)`,
      [
        serviceId, outletId, overrideText(b.name), categoryId, unitId, overrideText(b.unit),
        price.value, duration.value, minOrder.value, dcAdd.value, isActive,
      ]
    );
    res.json({ success: true, message: "Layanan outlet berhasil disimpan" });
  } catch (err) {
    console.error("upsertOutletService error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── 8. TERSEDIA / TIDAK TERSEDIA (massal) DI 1 OUTLET ──
export const setOutletServiceAvailability = async (req, res) => {
  try {
    const outletId = Number(req.params.outletId);
    const ids = parseOutletIds(req.body?.service_ids) || [];
    const available = req.body?.available ? 1 : 0;
    if (!ids.length) return res.status(400).json({ success: false, message: "Pilih minimal 1 layanan" });
    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });

    if (available) {
      await safeMyWaschenQuery(
        `INSERT INTO mst_service_outlet (service_id, outlet_id, is_active)
         SELECT id, ?, 1 FROM mst_service WHERE id IN (?)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [outletId, ids]
      );
    } else {
      await safeMyWaschenQuery(
        "UPDATE mst_service_outlet SET is_active = 0 WHERE outlet_id = ? AND service_id IN (?)",
        [outletId, ids]
      );
    }
    res.json({
      success: true,
      message: `${ids.length} layanan ${available ? "ditambahkan ke" : "dinonaktifkan dari"} outlet`,
    });
  } catch (err) {
    console.error("setOutletServiceAvailability error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
