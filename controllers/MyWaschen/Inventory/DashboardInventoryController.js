import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";

/**
 * GET /waschen/inventory/dashboard
 * Resume stok lintas outlet — untuk pantauan cepat sebelum masuk manajemen per outlet.
 */
export const getInventoryDashboard = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const lowOnly = String(req.query.lowOnly || "") === "1";
    const matrixLimit = Math.min(200, Math.max(10, Number(req.query.matrixLimit) || 80));

    const [overviewRows] = await safeMyWaschenQuery(`
      SELECT
        (SELECT COUNT(*) FROM mst_outlet) AS outlet_count,
        (SELECT COUNT(*) FROM mst_inventory_item WHERE is_active = 1) AS catalog_items,
        (SELECT COUNT(*) FROM tr_inventory_stock WHERE is_active = 1) AS stock_rows,
        (SELECT COUNT(*) FROM tr_inventory_stock s
           WHERE s.is_active = 1 AND s.min_stock > 0 AND s.qty_current <= s.min_stock) AS low_stock_count,
        (SELECT COUNT(*) FROM tr_inventory_stock s
           WHERE s.is_active = 1 AND s.qty_current <= 0) AS zero_stock_count,
        (SELECT COUNT(*) FROM tr_inventory_log
           WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS movements_7d
    `);
    const overview = overviewRows[0] || {};

    const [outlets] = await safeMyWaschenQuery(`
      SELECT
        o.id AS outlet_id,
        o.outlet_code,
        o.name,
        o.full_name,
        COUNT(s.id) AS total_items,
        SUM(CASE WHEN s.min_stock > 0 AND s.qty_current <= s.min_stock THEN 1 ELSE 0 END) AS low_stock_count,
        SUM(CASE WHEN s.qty_current <= 0 THEN 1 ELSE 0 END) AS zero_stock_count,
        COALESCE(SUM(s.qty_current), 0) AS total_qty,
        MAX(l.last_at) AS last_movement_at
      FROM mst_outlet o
      LEFT JOIN tr_inventory_stock s ON s.outlet_id = o.id AND s.is_active = 1
      LEFT JOIN (
        SELECT outlet_id, MAX(created_at) AS last_at
        FROM tr_inventory_log
        GROUP BY outlet_id
      ) l ON l.outlet_id = o.id
      GROUP BY o.id, o.outlet_code, o.name, o.full_name
      ORDER BY o.id ASC
    `);

    const lowWhere = ["s.is_active = 1", "s.min_stock > 0", "s.qty_current <= s.min_stock"];
    const lowParams = [];
    if (search) {
      lowWhere.push("(i.code LIKE ? OR i.name LIKE ? OR o.name LIKE ? OR o.outlet_code LIKE ?)");
      const like = `%${search}%`;
      lowParams.push(like, like, like, like);
    }

    const [lowStock] = await safeMyWaschenQuery(
      `SELECT
         s.id AS stock_id,
         s.outlet_id, o.outlet_code, o.name AS outlet_name,
         s.item_id, i.code AS item_code, i.name AS item_name,
         u.symbol AS unit,
         s.qty_current, s.min_stock, s.par_stock,
         (s.min_stock - s.qty_current) AS shortage
       FROM tr_inventory_stock s
       JOIN mst_inventory_item i ON i.id = s.item_id
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       JOIN mst_outlet o ON o.id = s.outlet_id
       WHERE ${lowWhere.join(" AND ")}
       ORDER BY (s.min_stock - s.qty_current) DESC, o.outlet_code ASC, i.name ASC
       LIMIT 100`,
      lowParams
    );

    const [outletCols] = await safeMyWaschenQuery(
      `SELECT id, outlet_code, name FROM mst_outlet ORDER BY id ASC`
    );

    const itemWhere = ["i.is_active = 1"];
    const itemParams = [];
    if (search) {
      itemWhere.push("(i.code LIKE ? OR i.name LIKE ? OR u.symbol LIKE ?)");
      const like = `%${search}%`;
      itemParams.push(like, like, like);
    }

    // Prefer items that are low somewhere when lowOnly=1
    let itemOrder = "i.name ASC";
    if (lowOnly) {
      itemWhere.push(`EXISTS (
        SELECT 1 FROM tr_inventory_stock sx
        WHERE sx.item_id = i.id AND sx.is_active = 1
          AND sx.min_stock > 0 AND sx.qty_current <= sx.min_stock
      )`);
      itemOrder = `(
        SELECT COUNT(*) FROM tr_inventory_stock sx
        WHERE sx.item_id = i.id AND sx.is_active = 1
          AND sx.min_stock > 0 AND sx.qty_current <= sx.min_stock
      ) DESC, i.name ASC`;
    }

    const [items] = await safeMyWaschenQuery(
      `SELECT i.id, i.code, i.name, u.symbol AS unit
       FROM mst_inventory_item i
       LEFT JOIN mst_unit u ON u.id = i.unit_id
       WHERE ${itemWhere.join(" AND ")}
       ORDER BY ${itemOrder}
       LIMIT ${matrixLimit}`,
      itemParams
    );

    let stockCells = [];
    if (items.length && outletCols.length) {
      const itemIds = items.map((i) => i.id);
      const [cells] = await safeMyWaschenQuery(
        `SELECT s.item_id, s.outlet_id, s.id AS stock_id,
                s.qty_current, s.min_stock, s.par_stock,
                CASE WHEN s.min_stock > 0 AND s.qty_current <= s.min_stock THEN 1 ELSE 0 END AS is_low
         FROM tr_inventory_stock s
         WHERE s.is_active = 1
           AND s.item_id IN (${itemIds.map(() => "?").join(",")})`,
        itemIds
      );
      stockCells = cells;
    }

    const cellMap = {};
    for (const c of stockCells) {
      if (!cellMap[c.item_id]) cellMap[c.item_id] = {};
      cellMap[c.item_id][c.outlet_id] = {
        stock_id: c.stock_id,
        qty: Number(c.qty_current) || 0,
        min: Number(c.min_stock) || 0,
        par: Number(c.par_stock) || 0,
        is_low: Number(c.is_low) === 1,
      };
    }

    const matrixItems = items.map((it) => ({
      id: it.id,
      code: it.code,
      name: it.name,
      unit: it.unit,
      byOutlet: cellMap[it.id] || {},
    }));

    const [recentLogs] = await safeMyWaschenQuery(`
      SELECT l.id, l.outlet_id, o.outlet_code, o.name AS outlet_name,
             l.item_id, i.code AS item_code, i.name AS item_name,
             u.symbol AS unit,
             l.movement_type, l.qty, l.qty_before, l.qty_after,
             l.employee_id, l.notes, l.created_at
      FROM tr_inventory_log l
      LEFT JOIN mst_outlet o ON o.id = l.outlet_id
      LEFT JOIN mst_inventory_item i ON i.id = l.item_id
      LEFT JOIN mst_unit u ON u.id = i.unit_id
      ORDER BY l.id DESC
      LIMIT 25
    `);

    const employeeIds = [...new Set(recentLogs.map((r) => r.employee_id).filter(Boolean))];
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
      data: {
        overview: {
          outletCount: Number(overview.outlet_count) || 0,
          catalogItems: Number(overview.catalog_items) || 0,
          stockRows: Number(overview.stock_rows) || 0,
          lowStockCount: Number(overview.low_stock_count) || 0,
          zeroStockCount: Number(overview.zero_stock_count) || 0,
          movements7d: Number(overview.movements_7d) || 0,
        },
        outlets: outlets.map((o) => ({
          ...o,
          total_items: Number(o.total_items) || 0,
          low_stock_count: Number(o.low_stock_count) || 0,
          zero_stock_count: Number(o.zero_stock_count) || 0,
          total_qty: Number(o.total_qty) || 0,
        })),
        lowStock,
        matrix: {
          outlets: outletCols,
          items: matrixItems,
        },
        recentLogs: recentLogs.map((r) => ({
          ...r,
          employee_name: r.employee_id ? empMap[r.employee_id] || null : null,
        })),
      },
    });
  } catch (err) {
    console.error("getInventoryDashboard error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
