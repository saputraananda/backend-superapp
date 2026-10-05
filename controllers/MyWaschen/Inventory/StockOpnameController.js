import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Recalculate qty_current = qty_opening − SUM(opname since period_start) */
async function recalcStockQty(stockId) {
  const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_inventory_stock WHERE id = ?", [stockId]);
  if (!rows.length) return null;
  const s = rows[0];

  const periodStart = s.period_start || null;
  const [actualRows] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(qty_used), 0) AS total
     FROM tr_stock_opname
     WHERE outlet_id = ? AND item_id = ?
       AND (? IS NULL OR usage_date >= ?)`,
    [s.outlet_id, s.item_id, periodStart, periodStart]
  );
  const actualQty = num(actualRows[0]?.total);
  const opening = num(s.qty_opening);
  const remaining = Math.max(0, opening - actualQty);

  await safeMyWaschenQuery(
    "UPDATE tr_inventory_stock SET qty_current = ?, updated_at = NOW() WHERE id = ?",
    [remaining, stockId]
  );
  return { opening, actualQty, remaining };
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

/** PUT /waschen/inventory/stock/:id/opening — admin set stok awal periode */
export const setOpeningStock = async (req, res) => {
  try {
    const { id } = req.params;
    const qtyOpening = num(req.body?.qty_opening, NaN);
    const minStock = req.body?.min_stock !== undefined ? num(req.body.min_stock) : undefined;
    let periodStart = req.body?.period_start
      ? String(req.body.period_start).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const employeeId = req.body?.employeeId
      ? Number(req.body.employeeId)
      : req.session?.employeeId
        ? Number(req.session.employeeId)
        : null;

    if (!Number.isFinite(qtyOpening) || qtyOpening < 0) {
      return res.status(400).json({ success: false, message: "qty_opening wajib angka ≥ 0" });
    }
    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Petugas wajib dipilih" });
    }
    const emp = await assertEmployee(employeeId);
    if (!emp) {
      return res.status(404).json({ success: false, message: "Petugas tidak ditemukan" });
    }

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_inventory_stock WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Stok outlet tidak ditemukan" });
    }

    const updates = ["qty_opening = ?", "period_start = ?", "updated_at = NOW()"];
    const params = [qtyOpening, periodStart];

    if (minStock !== undefined) {
      updates.splice(2, 0, "min_stock = ?");
      params.splice(2, 0, minStock);
    }

    params.push(id);
    await safeMyWaschenQuery(
      `UPDATE tr_inventory_stock SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    const calc = await recalcStockQty(id);

    await safeMyWaschenQuery(
      `INSERT INTO tr_inventory_log
         (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
       VALUES (?, ?, ?, 'Adjust', ?, ?, ?, ?, 'opening', ?)`,
      [
        rows[0].outlet_id,
        rows[0].item_id,
        id,
        qtyOpening,
        num(rows[0].qty_current),
        calc?.remaining ?? qtyOpening,
        employeeId,
        `Set stok awal periode ${periodStart}`,
      ]
    );

    res.json({
      success: true,
      message: "Stok awal periode disimpan",
      data: { qty_opening: qtyOpening, period_start: periodStart, ...calc },
    });
  } catch (err) {
    console.error("setOpeningStock error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/inventory/opname/daily?outletId=&usageDate= */
export const getDailyOpname = async (req, res) => {
  try {
    const outletId = Number(req.query.outletId);
    const usageDate = String(req.query.usageDate || new Date().toISOString().slice(0, 10)).slice(0, 10);

    if (!outletId) {
      return res.status(400).json({ success: false, message: "outletId wajib" });
    }

    const [rows] = await safeMyWaschenQuery(
      `SELECT o.*, i.code AS item_code, i.name AS item_name, u.symbol AS item_unit
       FROM tr_stock_opname o
       JOIN mst_inventory_item i ON i.id = o.item_id
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       WHERE o.outlet_id = ? AND o.usage_date = ?
       ORDER BY i.name ASC`,
      [outletId, usageDate]
    );

    res.json({ success: true, data: rows, usageDate });
  } catch (err) {
    console.error("getDailyOpname error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** POST /waschen/inventory/opname/daily — tim produksi input pemakaian harian */
export const postDailyOpname = async (req, res) => {
  try {
    const outletId = Number(req.body?.outletId);
    const usageDate = String(req.body?.usageDate || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const employeeId = req.body?.employeeId
      ? Number(req.body.employeeId)
      : req.session?.employeeId
        ? Number(req.session.employeeId)
        : null;
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];

    if (!outletId) {
      return res.status(400).json({ success: false, message: "outletId wajib" });
    }
    if (!lines.length) {
      return res.status(400).json({ success: false, message: "Minimal 1 baris pemakaian" });
    }
    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Petugas wajib dipilih" });
    }

    const emp = await assertEmployee(employeeId);
    if (!emp) {
      return res.status(404).json({ success: false, message: "Petugas tidak ditemukan" });
    }

    let saved = 0;

    for (const line of lines) {
      const itemId = Number(line.itemId);
      const qtyUsed = num(line.qtyUsed, NaN);
      const notes = line.notes?.trim() || null;

      if (!itemId || !Number.isFinite(qtyUsed) || qtyUsed < 0) continue;

      const [stock] = await safeMyWaschenQuery(
        "SELECT id, qty_current FROM tr_inventory_stock WHERE outlet_id = ? AND item_id = ? AND is_active = 1 LIMIT 1",
        [outletId, itemId]
      );
      if (!stock.length) continue;

      const stockId = stock[0].id;
      const before = num(stock[0].qty_current);
      const [prevRows] = await safeMyWaschenQuery(
        "SELECT qty_used FROM tr_stock_opname WHERE outlet_id = ? AND item_id = ? AND usage_date = ? LIMIT 1",
        [outletId, itemId, usageDate]
      );
      const prevUsed = num(prevRows[0]?.qty_used);

      if (qtyUsed === 0) {
        await safeMyWaschenQuery(
          "DELETE FROM tr_stock_opname WHERE outlet_id = ? AND item_id = ? AND usage_date = ?",
          [outletId, itemId, usageDate]
        );
      } else {
        await safeMyWaschenQuery(
          `INSERT INTO tr_stock_opname (outlet_id, item_id, stock_id, usage_date, qty_used, employee_id, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             qty_used = VALUES(qty_used),
             employee_id = VALUES(employee_id),
             notes = VALUES(notes),
             stock_id = VALUES(stock_id),
             updated_at = NOW()`,
          [outletId, itemId, stockId, usageDate, qtyUsed, employeeId, notes]
        );
      }

      const after = before - (qtyUsed - prevUsed);
      await safeMyWaschenQuery(
        "UPDATE tr_inventory_stock SET qty_current = ?, updated_at = NOW() WHERE id = ?",
        [after, stockId]
      );
      if (qtyUsed !== prevUsed) {
        await safeMyWaschenQuery(
          `INSERT INTO tr_inventory_log
             (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
           VALUES (?, ?, ?, 'Usage', ?, ?, ?, ?, 'opname_daily', ?)`,
          [
            outletId,
            itemId,
            stockId,
            Math.abs(qtyUsed - prevUsed),
            before,
            after,
            employeeId,
            notes || `Pemakaian harian ${usageDate}`,
          ]
        );
      }

      saved += 1;
    }

    res.json({
      success: true,
      message: `Pemakaian harian tersimpan (${saved} item)`,
      saved,
    });
  } catch (err) {
    console.error("postDailyOpname error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

function todayWibISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

/** POST /waschen/inventory/opname/item — tambah pemakaian hari ini, atau set sisa stok */
export const postItemMove = async (req, res) => {
  try {
    const outletId = Number(req.body?.outletId);
    const itemId = Number(req.body?.itemId);
    const mode = req.body?.mode === "set" ? "set" : "add";
    const qty = num(req.body?.qty, NaN);
    const employeeId = req.body?.employeeId
      ? Number(req.body.employeeId)
      : req.session?.employeeId
        ? Number(req.session.employeeId)
        : null;

    if (!outletId || !itemId) {
      return res.status(400).json({ success: false, message: "Item dan outlet wajib" });
    }
    if (!Number.isFinite(qty) || qty < 0 || (mode === "add" && qty <= 0)) {
      return res.status(400).json({ success: false, message: mode === "set" ? "Sisa stok tidak valid" : "Jumlah pemakaian tidak valid" });
    }
    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Petugas wajib dipilih" });
    }
    const emp = await assertEmployee(employeeId);
    if (!emp) {
      return res.status(404).json({ success: false, message: "Petugas tidak ditemukan" });
    }

    const [stockRows] = await safeMyWaschenQuery(
      "SELECT * FROM tr_inventory_stock WHERE outlet_id = ? AND item_id = ? AND is_active = 1 LIMIT 1",
      [outletId, itemId]
    );
    if (!stockRows.length) {
      return res.status(404).json({ success: false, message: "Stok item tidak ditemukan di outlet ini" });
    }
    const stock = stockRows[0];
    const before = num(stock.qty_current);
    const today = todayWibISO();

    if (mode === "add") {
      await safeMyWaschenQuery(
        `INSERT INTO tr_stock_opname (outlet_id, item_id, stock_id, usage_date, qty_used, employee_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           stock_id = VALUES(stock_id),
           qty_used = qty_used + VALUES(qty_used),
           employee_id = VALUES(employee_id),
           notes = VALUES(notes),
           updated_at = NOW()`,
        [outletId, itemId, stock.id, today, qty, employeeId, "SO My Waschen POS"]
      );
      const after = before - qty;
      await safeMyWaschenQuery(
        "UPDATE tr_inventory_stock SET qty_current = ?, updated_at = NOW() WHERE id = ?",
        [after, stock.id]
      );
      await safeMyWaschenQuery(
        `INSERT INTO tr_inventory_log
           (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
         VALUES (?, ?, ?, 'Usage', ?, ?, ?, ?, 'opname', 'SO My Waschen POS')`,
        [outletId, itemId, stock.id, qty, before, after, employeeId]
      );
      const [todayRows] = await safeMyWaschenQuery(
        "SELECT qty_used FROM tr_stock_opname WHERE outlet_id = ? AND item_id = ? AND usage_date = ? LIMIT 1",
        [outletId, itemId, today]
      );
      return res.json({
        success: true,
        message: "Pemakaian ditambahkan",
        data: { qty_today: num(todayRows[0]?.qty_used), qty_current: after },
      });
    }

    const after = qty;
    await safeMyWaschenQuery(
      "UPDATE tr_inventory_stock SET qty_current = ?, updated_at = NOW() WHERE id = ?",
      [after, stock.id]
    );
    await safeMyWaschenQuery(
      `INSERT INTO tr_inventory_log
         (outlet_id, item_id, stock_id, movement_type, qty, qty_before, qty_after, employee_id, reference_type, notes)
       VALUES (?, ?, ?, 'Adjust', ?, ?, ?, ?, 'opname', 'SO My Waschen POS')`,
      [outletId, itemId, stock.id, Math.abs(after - before), before, after, employeeId]
    );
    const [todayRows] = await safeMyWaschenQuery(
      "SELECT qty_used FROM tr_stock_opname WHERE outlet_id = ? AND item_id = ? AND usage_date = ? LIMIT 1",
      [outletId, itemId, today]
    );
    return res.json({
      success: true,
      message: "Sisa stok diset",
      data: { qty_today: num(todayRows[0]?.qty_used), qty_current: after },
    });
  } catch (err) {
    console.error("postItemMove error:", err);
    return res.status(500).json({ success: false, message: "Gagal menyimpan stok" });
  }
};
