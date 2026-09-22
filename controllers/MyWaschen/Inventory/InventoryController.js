import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function slugCode(name) {
  return String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function assertEmployee(employeeId) {
  const id = Number(employeeId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name FROM mst_employee
     WHERE employee_id = ? AND is_deleted = 0 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

const ITEM_SORT = ["id", "code", "name", "unit_id", "created_at"];
const STOCK_SORT = ["name", "qty_current", "qty_opening", "min_stock", "par_stock", "updated_at", "code"];

async function assertUnitId(unitId) {
  const id = Number(unitId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [rows] = await safeMyWaschenQuery(
    "SELECT id, name, symbol FROM mst_unit WHERE id = ? AND is_active = 1 LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

/** GET /waschen/inventory/items */
export const getInventoryItems = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = ITEM_SORT.includes(req.query.sortBy) ? req.query.sortBy : "name";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const sortCol = sortBy === "unit_id" ? "i.unit_id" : `i.${sortBy}`;

    const where = [];
    const params = [];
    if (search) {
      where.push("(i.code LIKE ? OR i.name LIKE ? OR u.symbol LIKE ? OR u.name LIKE ? OR i.description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (isActive !== undefined && isActive !== "") {
      where.push("i.is_active = ?");
      params.push(Number(isActive));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `SELECT i.*, u.name AS unit_name, u.symbol AS unit_symbol, u.symbol AS unit
       FROM mst_inventory_item i
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       ${whereSql}
       ORDER BY ${sortCol} ${sortDir}, i.name ASC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getInventoryItems error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/inventory/items */
export const createInventoryItem = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const unitId = Number(req.body?.unit_id);
    const description = String(req.body?.description || "").trim() || null;
    const isActive = req.body?.is_active !== undefined ? Number(req.body.is_active) : 1;
    let code = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "-");

    if (!name) {
      return res.status(400).json({ success: false, message: "Nama item wajib diisi" });
    }
    const unit = await assertUnitId(unitId);
    if (!unit) {
      return res.status(400).json({ success: false, message: "Satuan (unit_id) wajib dipilih dari mst_unit" });
    }
    if (!code) code = `INV-${slugCode(name).slice(0, 20)}`;

    const [dupCode] = await safeMyWaschenQuery("SELECT id FROM mst_inventory_item WHERE code = ?", [code]);
    if (dupCode.length) {
      return res.status(400).json({ success: false, message: `Kode "${code}" sudah dipakai` });
    }
    const [dupName] = await safeMyWaschenQuery("SELECT id FROM mst_inventory_item WHERE name = ?", [name]);
    if (dupName.length) {
      return res.status(400).json({ success: false, message: `Nama "${name}" sudah ada` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_inventory_item (code, name, unit_id, description, is_active) VALUES (?, ?, ?, ?, ?)`,
      [code, name, unit.id, description, isActive]
    );
    res.status(201).json({ success: true, message: "Item inventory ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createInventoryItem error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PUT /waschen/inventory/items/:id */
export const updateInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_inventory_item WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Item tidak ditemukan" });
    }

    const name = String(req.body?.name || "").trim();
    const unitId = Number(req.body?.unit_id);
    const description = String(req.body?.description || "").trim() || null;
    const isActive = req.body?.is_active !== undefined ? Number(req.body.is_active) : 1;
    const code = String(req.body?.code || "").trim().toUpperCase().replace(/\s+/g, "-");

    if (!name || !code) {
      return res.status(400).json({ success: false, message: "Kode dan Nama wajib diisi" });
    }
    const unit = await assertUnitId(unitId);
    if (!unit) {
      return res.status(400).json({ success: false, message: "Satuan (unit_id) wajib dipilih dari mst_unit" });
    }

    const [dupCode] = await safeMyWaschenQuery(
      "SELECT id FROM mst_inventory_item WHERE code = ? AND id != ?",
      [code, id]
    );
    if (dupCode.length) {
      return res.status(400).json({ success: false, message: `Kode "${code}" sudah dipakai` });
    }
    const [dupName] = await safeMyWaschenQuery(
      "SELECT id FROM mst_inventory_item WHERE name = ? AND id != ?",
      [name, id]
    );
    if (dupName.length) {
      return res.status(400).json({ success: false, message: `Nama "${name}" sudah ada` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_inventory_item
       SET code = ?, name = ?, unit_id = ?, description = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [code, name, unit.id, description, isActive, id]
    );
    res.json({ success: true, message: "Item inventory diperbarui" });
  } catch (err) {
    console.error("updateInventoryItem error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** DELETE /waschen/inventory/items/:id */
export const deleteInventoryItem = async (req, res) => {
  try {
    const { id } = req.params;
    const [used] = await safeMyWaschenQuery(
      "SELECT id FROM tr_inventory_stock WHERE item_id = ? LIMIT 1",
      [id]
    );
    if (used.length) {
      await safeMyWaschenQuery(
        "UPDATE mst_inventory_item SET is_active = 0, updated_at = NOW() WHERE id = ?",
        [id]
      );
      return res.json({
        success: true,
        message: "Item masih dipakai di outlet — dinonaktifkan (soft delete)",
      });
    }
    await safeMyWaschenQuery("DELETE FROM mst_inventory_item WHERE id = ?", [id]);
    res.json({ success: true, message: "Item inventory dihapus" });
  } catch (err) {
    console.error("deleteInventoryItem error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/inventory/stock?outletId= */
export const getOutletStock = async (req, res) => {
  try {
    const outletId = Number(req.query.outletId);
    if (!Number.isFinite(outletId) || outletId <= 0) {
      return res.status(400).json({ success: false, message: "outletId wajib diisi" });
    }

    const search = String(req.query.search || "").trim();
    const lowOnly = String(req.query.lowOnly || "") === "1";
    const sortBy = STOCK_SORT.includes(req.query.sortBy) ? req.query.sortBy : "name";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const sortCol = sortBy === "name" || sortBy === "code" ? `i.${sortBy}` : `s.${sortBy}`;

    const where = ["s.outlet_id = ?", "s.is_active = 1"];
    const params = [outletId];

    if (search) {
      where.push("(i.code LIKE ? OR i.name LIKE ? OR u.symbol LIKE ? OR u.name LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    if (lowOnly) {
      where.push("s.qty_current <= s.min_stock AND s.min_stock > 0");
    }

    const [rows] = await safeMyWaschenQuery(
      `SELECT s.*,
              i.code AS item_code, i.name AS item_name, i.unit_id AS item_unit_id,
              u.symbol AS item_unit, u.name AS item_unit_name,
              i.description AS item_description, i.is_active AS item_is_active,
              o.name AS outlet_name, o.full_name AS outlet_full_name, o.outlet_code,
              (SELECT COALESCE(SUM(o2.qty_used), 0)
               FROM tr_stock_opname o2
               WHERE o2.outlet_id = s.outlet_id AND o2.item_id = s.item_id
                 AND (s.period_start IS NULL OR o2.usage_date >= s.period_start)
              ) AS qty_actual,
              (SELECT COALESCE(SUM(td.qty * si.qty_per_service), 0)
               FROM tr_transaction_detail td
               INNER JOIN tr_transaction t ON t.id = td.transaction_id
               INNER JOIN mst_service_inventory si
                 ON si.service_id = td.service_id AND si.item_id = s.item_id AND si.is_active = 1
               WHERE t.outlet_id = s.outlet_id
                 AND td.item_work_status IN ('Selesai', 'Siap Diambil', 'Siap Diantar')
                 AND (s.period_start IS NULL
                      OR DATE(COALESCE(td.item_completed_at, t.order_date)) >= s.period_start)
              ) AS qty_expected,
              CASE WHEN s.min_stock > 0 AND s.qty_current <= s.min_stock THEN 1 ELSE 0 END AS is_low_stock
       FROM tr_inventory_stock s
       JOIN mst_inventory_item i ON i.id = s.item_id
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       LEFT JOIN mst_outlet o ON o.id = s.outlet_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${sortCol} ${sortDir}, i.name ASC`,
      params
    );

    const data = rows.map((r) => {
      const qtyExpected = num(r.qty_expected);
      const qtyActual = num(r.qty_actual);
      return {
        ...r,
        qty_expected: qtyExpected,
        qty_actual: qtyActual,
        qty_remaining: num(r.qty_current),
        qty_variance: qtyExpected - qtyActual,
      };
    });

    const [summaryRows] = await safeMyWaschenQuery(
      `SELECT
         COUNT(*) AS total_items,
         SUM(CASE WHEN s.min_stock > 0 AND s.qty_current <= s.min_stock THEN 1 ELSE 0 END) AS low_stock_count,
         SUM(s.qty_current) AS total_qty
       FROM tr_inventory_stock s
       WHERE s.outlet_id = ? AND s.is_active = 1`,
      [outletId]
    );

    res.json({
      success: true,
      data,
      summary: {
        totalItems: num(summaryRows[0]?.total_items),
        lowStockCount: num(summaryRows[0]?.low_stock_count),
        totalQty: num(summaryRows[0]?.total_qty),
      },
    });
  } catch (err) {
    console.error("getOutletStock error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/inventory/stock — assign item ke outlet */
export const assignItemToOutlet = async (req, res) => {
  try {
    const outletId = Number(req.body?.outletId);
    const itemId = Number(req.body?.itemId);
    const qtyCurrent = num(req.body?.qty_current, 0);
    const minStock = num(req.body?.min_stock, 0);
    const parStock = num(req.body?.par_stock, 0);
    const employeeId = req.body?.employeeId ? Number(req.body.employeeId) : null;
    const notes = String(req.body?.notes || "").trim() || "Assign item ke outlet";

    if (!outletId || !itemId) {
      return res.status(400).json({ success: false, message: "outletId dan itemId wajib" });
    }

    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }
    const [item] = await safeMyWaschenQuery(
      "SELECT id, name FROM mst_inventory_item WHERE id = ? AND is_active = 1",
      [itemId]
    );
    if (!item.length) {
      return res.status(404).json({ success: false, message: "Item tidak ditemukan / nonaktif" });
    }

    const [exist] = await safeMyWaschenQuery(
      "SELECT id, is_active FROM tr_inventory_stock WHERE outlet_id = ? AND item_id = ?",
      [outletId, itemId]
    );

    let stockId;
    if (exist.length) {
      stockId = exist[0].id;
      await safeMyWaschenQuery(
        `UPDATE tr_inventory_stock
         SET qty_opening = ?, qty_current = ?, min_stock = ?, par_stock = ?, is_active = 1, updated_at = NOW()
         WHERE id = ?`,
        [qtyCurrent, qtyCurrent, minStock, parStock, stockId]
      );
    } else {
      const [ins] = await safeMyWaschenQuery(
        `INSERT INTO tr_inventory_stock (outlet_id, item_id, qty_opening, qty_current, min_stock, par_stock)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [outletId, itemId, qtyCurrent, qtyCurrent, minStock, parStock]
      );
      stockId = ins.insertId;
    }

    if (qtyCurrent > 0) {
      await safeMyWaschenQuery(
        `INSERT INTO tr_inventory_log
           (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
         VALUES (?, ?, ?, 'In', ?, 0, ?, ?, 'manual', ?)`,
        [outletId, itemId, stockId, qtyCurrent, qtyCurrent, employeeId, notes]
      );
    }

    res.status(201).json({
      success: true,
      message: `Item "${item[0].name}" ditambahkan ke outlet`,
      id: stockId,
    });
  } catch (err) {
    console.error("assignItemToOutlet error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PUT /waschen/inventory/stock/:id — update min/par (tanpa ubah qty) */
export const updateOutletStock = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_inventory_stock WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Stok outlet tidak ditemukan" });
    }

    const minStock = req.body?.min_stock !== undefined ? num(req.body.min_stock) : num(rows[0].min_stock);
    const parStock = req.body?.par_stock !== undefined ? num(req.body.par_stock) : num(rows[0].par_stock);
    const isActive = req.body?.is_active !== undefined ? Number(req.body.is_active) : Number(rows[0].is_active);

    await safeMyWaschenQuery(
      `UPDATE tr_inventory_stock
       SET min_stock = ?, par_stock = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [minStock, parStock, isActive, id]
    );
    res.json({ success: true, message: "Pengaturan stok outlet diperbarui" });
  } catch (err) {
    console.error("updateOutletStock error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/inventory/stock/:id/adjust */
export const adjustOutletStock = async (req, res) => {
  try {
    const { id } = req.params;
    const movementType = String(req.body?.movementType || "Adjust").trim();
    const qtyRaw = num(req.body?.qty, NaN);
    const employeeId = req.body?.employeeId ? Number(req.body.employeeId) : null;
    const notes = String(req.body?.notes || "").trim() || null;
    const setQty = req.body?.setQty !== undefined && req.body?.setQty !== null ? num(req.body.setQty) : null;

    if (!["In", "Out", "Adjust"].includes(movementType)) {
      return res.status(400).json({ success: false, message: "movementType harus In / Out / Adjust" });
    }

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_inventory_stock WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Stok outlet tidak ditemukan" });
    }
    const stock = rows[0];
    const before = num(stock.qty_current);
    const openingBefore = num(stock.qty_opening);

    const [actualRows] = await safeMyWaschenQuery(
      `SELECT COALESCE(SUM(qty_used), 0) AS total
       FROM tr_stock_opname
       WHERE outlet_id = ? AND item_id = ?
         AND (? IS NULL OR usage_date >= ?)`,
      [stock.outlet_id, stock.item_id, stock.period_start, stock.period_start]
    );
    const actualQty = num(actualRows[0]?.total);

    let newOpening = openingBefore;
    let after = before;
    let loggedQty = 0;
    let type = movementType;

    if (movementType === "Adjust" && setQty !== null) {
      after = Math.max(0, setQty);
      newOpening = Math.max(0, after + actualQty);
      loggedQty = Math.abs(newOpening - openingBefore);
      type = newOpening >= openingBefore ? "In" : "Out";
      if (after === before) type = "Adjust";
    } else {
      if (!Number.isFinite(qtyRaw) || qtyRaw <= 0) {
        return res.status(400).json({ success: false, message: "qty harus angka positif" });
      }
      loggedQty = qtyRaw;
      if (movementType === "In") {
        newOpening = openingBefore + qtyRaw;
        after = Math.max(0, newOpening - actualQty);
      } else if (movementType === "Out") {
        newOpening = Math.max(0, openingBefore - qtyRaw);
        after = Math.max(0, newOpening - actualQty);
      } else {
        newOpening = qtyRaw;
        after = Math.max(0, newOpening - actualQty);
      }
    }

    if (employeeId) {
      const emp = await assertEmployee(employeeId);
      if (!emp) {
        return res.status(404).json({ success: false, message: "Karyawan (mst_employee) tidak ditemukan" });
      }
    }

    await safeMyWaschenQuery(
      "UPDATE tr_inventory_stock SET qty_opening = ?, qty_current = ?, updated_at = NOW() WHERE id = ?",
      [newOpening, after, id]
    );

    await safeMyWaschenQuery(
      `INSERT INTO tr_inventory_log
         (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
      [stock.outlet_id, stock.item_id, stock.id, type, loggedQty, before, after, employeeId, notes]
    );

    res.json({
      success: true,
      message: "Stok diperbarui",
      data: { stockId: Number(id), qtyBefore: before, qtyAfter: after, movementType: type },
    });
  } catch (err) {
    console.error("adjustOutletStock error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** DELETE /waschen/inventory/stock/:id — lepaskan item dari outlet */
export const removeOutletStock = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_inventory_stock WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Stok outlet tidak ditemukan" });
    }

    await safeMyWaschenQuery(
      "UPDATE tr_inventory_stock SET is_active = 0, updated_at = NOW() WHERE id = ?",
      [id]
    );
    res.json({ success: true, message: "Item dinonaktifkan dari outlet" });
  } catch (err) {
    console.error("removeOutletStock error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/inventory/stock/seed-outlet — isi semua katalog ke outlet (qty 0) */
export const seedOutletCatalog = async (req, res) => {
  try {
    const outletId = Number(req.body?.outletId);
    if (!outletId) {
      return res.status(400).json({ success: false, message: "outletId wajib" });
    }
    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO tr_inventory_stock (outlet_id, item_id, qty_opening, qty_current, min_stock, par_stock, is_active)
       SELECT ?, i.id, 0, 0, 0, 0, 1
       FROM mst_inventory_item i
       WHERE i.is_active = 1
         AND NOT EXISTS (
           SELECT 1 FROM tr_inventory_stock s
           WHERE s.outlet_id = ? AND s.item_id = i.id
         )`,
      [outletId, outletId]
    );

    // reactivate soft-removed
    await safeMyWaschenQuery(
      `UPDATE tr_inventory_stock s
       JOIN mst_inventory_item i ON i.id = s.item_id AND i.is_active = 1
       SET s.is_active = 1, s.updated_at = NOW()
       WHERE s.outlet_id = ? AND s.is_active = 0`,
      [outletId]
    );

    res.json({
      success: true,
      message: `Katalog disalin ke outlet (${result.affectedRows || 0} item baru)`,
      inserted: result.affectedRows || 0,
    });
  } catch (err) {
    console.error("seedOutletCatalog error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/inventory/logs */
export const getInventoryLogs = async (req, res) => {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const itemId = req.query.itemId ? Number(req.query.itemId) : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const where = [];
    const params = [];
    if (outletId) {
      where.push("l.outlet_id = ?");
      params.push(outletId);
    }
    if (itemId) {
      where.push("l.item_id = ?");
      params.push(itemId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT l.*, i.code AS item_code, i.name AS item_name,
              u.symbol AS item_unit, i.unit_id AS item_unit_id,
              o.name AS outlet_name, o.outlet_code
       FROM tr_inventory_log l
       LEFT JOIN mst_inventory_item i ON i.id = l.item_id
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       LEFT JOIN mst_outlet o ON o.id = l.outlet_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT ${limit}`,
      params
    );

    const employeeIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))];
    let empMap = {};
    if (employeeIds.length) {
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee
         WHERE employee_id IN (${employeeIds.map(() => "?").join(",")})`,
        employeeIds
      );
      empMap = Object.fromEntries(emps.map((e) => [e.employee_id, e.full_name]));
    }

    res.json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        employee_name: r.employee_id ? empMap[r.employee_id] || null : null,
      })),
    });
  } catch (err) {
    console.error("getInventoryLogs error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/inventory/items-available?outletId= — katalog belum di outlet */
export const getAvailableItemsForOutlet = async (req, res) => {
  try {
    const outletId = Number(req.query.outletId);
    if (!outletId) {
      return res.status(400).json({ success: false, message: "outletId wajib" });
    }
    const [rows] = await safeMyWaschenQuery(
      `SELECT i.*, u.symbol AS unit, u.symbol AS unit_symbol, u.name AS unit_name
       FROM mst_inventory_item i
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       WHERE i.is_active = 1
         AND NOT EXISTS (
           SELECT 1 FROM tr_inventory_stock s
           WHERE s.outlet_id = ? AND s.item_id = i.id AND s.is_active = 1
         )
       ORDER BY i.name ASC`,
      [outletId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getAvailableItemsForOutlet error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/inventory/employees — semua karyawan aktif + petugas login saat ini */
export const getInventoryPetugas = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const where = ["e.is_deleted = 0", "e.exit_date IS NULL"];
    const params = [];

    if (search) {
      where.push("(e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const [rows] = await safeQuery(
      `SELECT e.employee_id, e.employee_code, e.full_name, e.email,
              e.company_id, c.company_name
       FROM mst_employee e
       LEFT JOIN mst_company c ON c.company_id = e.company_id
       WHERE ${where.join(" AND ")}
       ORDER BY e.full_name ASC
       LIMIT 500`,
      params
    );

    let current = null;
    const sessionEmpId = Number(req.session?.employeeId);
    if (Number.isFinite(sessionEmpId) && sessionEmpId > 0) {
      current = rows.find((r) => Number(r.employee_id) === sessionEmpId) || null;
      if (!current) {
        const [curRows] = await safeQuery(
          `SELECT e.employee_id, e.employee_code, e.full_name, e.email,
                  e.company_id, c.company_name
           FROM mst_employee e
           LEFT JOIN mst_company c ON c.company_id = e.company_id
           WHERE e.employee_id = ? AND e.is_deleted = 0
           LIMIT 1`,
          [sessionEmpId]
        );
        current = curRows[0] || null;
      }
    }

    res.json({ success: true, data: rows, current });
  } catch (err) {
    console.error("getInventoryPetugas error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
