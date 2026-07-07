import { ikmPool, safeIKMQuery, safeQuery } from "../../db/pool.js";

// Helper to resolve employee names from the main database
async function resolveEmployeeNames(employeeIds) {
  if (!employeeIds || employeeIds.length === 0) return {};
  try {
    const [rows] = await safeQuery(
      "SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (?)",
      [employeeIds]
    );
    const mapping = {};
    rows.forEach(r => {
      mapping[r.employee_id] = r.full_name;
    });
    return mapping;
  } catch (err) {
    console.error("[StockOpnameController] Error resolving employee names:", err);
    return {};
  }
}

// 1. GET /ikm/stock-opname - Get stock opname history for a hospital
export async function getStockOpnameHistory(req, res) {
  try {
    const { hospital_id } = req.query;
    if (!hospital_id) {
      return res.status(400).json({ message: "Parameter hospital_id diperlukan" });
    }

    // Fetch headers
    const [headers] = await safeIKMQuery(
      `SELECT so.id, so.hospital_id, so.opname_type, so.opname_date, so.pic_employee_id, so.room_id, so.created_at,
              r.room_name
       FROM tr_stock_opname so
       LEFT JOIN mst_rooms_rs r ON so.room_id = r.id
       WHERE so.hospital_id = ?
       ORDER BY so.opname_date DESC, so.created_at DESC`,
      [hospital_id]
    );

    if (headers.length === 0) {
      return res.json({ data: [] });
    }

    // Fetch employee mapping
    const employeeIds = [...new Set(headers.map(h => h.pic_employee_id).filter(Boolean))];
    const employeeMap = await resolveEmployeeNames(employeeIds);

    // Fetch details count and sum per opname header
    const headerIds = headers.map(h => h.id);
    const [stats] = await safeIKMQuery(
      `SELECT stock_opname_id, COUNT(*) AS item_count, SUM(stock_qty) AS total_qty
       FROM tr_stock_opname_detail
       WHERE stock_opname_id IN (?)
       GROUP BY stock_opname_id`,
      [headerIds]
    );

    const statsMap = {};
    stats.forEach(s => {
      statsMap[s.stock_opname_id] = {
        item_count: Number(s.item_count) || 0,
        total_qty: Number(s.total_qty) || 0
      };
    });

    const result = headers.map(h => ({
      ...h,
      pic_name: employeeMap[h.pic_employee_id] || "—",
      item_count: statsMap[h.id]?.item_count || 0,
      total_qty: statsMap[h.id]?.total_qty || 0
    }));

    res.json({ data: result });
  } catch (err) {
    console.error("[StockOpnameController] getStockOpnameHistory error:", err);
    res.status(500).json({ message: err.message || "Terjadi kesalahan internal" });
  }
}

// 2. GET /ikm/stock-opname/:id - Get stock opname details
export async function getStockOpnameById(req, res) {
  try {
    const { id } = req.params;

    // Fetch header
    const [headers] = await safeIKMQuery(
      `SELECT so.id, so.hospital_id, so.opname_type, so.opname_date, so.pic_employee_id, so.room_id, so.created_at,
              r.room_name
       FROM tr_stock_opname so
       LEFT JOIN mst_rooms_rs r ON so.room_id = r.id
       WHERE so.id = ?`,
      [id]
    );

    if (headers.length === 0) {
      return res.status(404).json({ message: "Stock opname tidak ditemukan" });
    }

    const header = headers[0];

    // Fetch employee name
    if (header.pic_employee_id) {
      const employeeMap = await resolveEmployeeNames([header.pic_employee_id]);
      header.pic_name = employeeMap[header.pic_employee_id] || "—";
    } else {
      header.pic_name = "—";
    }

    // Fetch details
    const [details] = await safeIKMQuery(
      `SELECT d.id, d.stock_opname_id, d.hospital_linen_id, d.stock_qty,
              hl.hospital_linen_name, hl.unit, hl.grammage, hl.ownership_type,
              l.linen_code, l.linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM tr_stock_opname_detail d
       JOIN mst_hospital_linen hl ON d.hospital_linen_id = hl.id
       JOIN mst_linen l ON hl.linen_id = l.id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE d.stock_opname_id = ?
       ORDER BY l.linen_code ASC`,
      [id]
    );

    res.json({
      header,
      details
    });
  } catch (err) {
    console.error("[StockOpnameController] getStockOpnameById error:", err);
    res.status(500).json({ message: err.message || "Terjadi kesalahan internal" });
  }
}

// 3. POST /ikm/stock-opname - Create a new stock opname
export async function createStockOpname(req, res) {
  let connection;
  try {
    const { hospital_id, opname_type, opname_date, room_id, details } = req.body;

    if (!hospital_id || !opname_type || !opname_date || !details || !Array.isArray(details) || details.length === 0) {
      return res.status(400).json({ message: "Data hospital_id, opname_type, opname_date, dan details (array) diperlukan" });
    }

    const pic_employee_id = req.session.employeeId || null;

    connection = await ikmPool.getConnection();
    await connection.beginTransaction();

    // Check if the hospital has any rooms
    const [rooms] = await connection.query("SELECT id FROM mst_rooms_rs WHERE hospital_id = ?", [hospital_id]);
    const hasRooms = rooms.length > 0;

    if (opname_type === "RS" && hasRooms && !room_id) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({ message: "Ruangan wajib dipilih jika tipe stock opname adalah RS" });
    }

    // Insert Header
    const [headerResult] = await connection.query(
      "INSERT INTO tr_stock_opname (hospital_id, opname_type, opname_date, pic_employee_id, room_id) VALUES (?, ?, ?, ?, ?)",
      [hospital_id, opname_type, opname_date, pic_employee_id, opname_type === "RS" && room_id ? room_id : null]
    );

    const stock_opname_id = headerResult.insertId;

    // Insert Details
    const insertValues = details.map(item => [
      stock_opname_id,
      item.hospital_linen_id,
      item.stock_qty || 0
    ]);

    await connection.query(
      "INSERT INTO tr_stock_opname_detail (stock_opname_id, hospital_linen_id, stock_qty) VALUES ?",
      [insertValues]
    );

    // Update stock levels in mst_hospital_linen / mst_hospital_linen_rooms based on opname_type
    for (const item of details) {
      if (opname_type === "RS") {
        if (room_id) {
          // 1. Upsert room stock
          await connection.query(
            `INSERT INTO mst_hospital_linen_rooms (hospital_linen_id, room_id, stock_in_rs)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE stock_in_rs = VALUES(stock_in_rs)`,
            [item.hospital_linen_id, room_id, item.stock_qty || 0]
          );

          // 2. Recalculate total stock_in_rs for this linen
          await connection.query(
            `UPDATE mst_hospital_linen hl
             SET hl.stock_in_rs = (
               SELECT COALESCE(SUM(stock_in_rs), 0)
               FROM mst_hospital_linen_rooms
               WHERE hospital_linen_id = hl.id
             )
             WHERE hl.id = ? AND hl.hospital_id = ?`,
            [item.hospital_linen_id, hospital_id]
          );

          // 3. Update current_stock
          await connection.query(
            `UPDATE mst_hospital_linen hl
             SET hl.current_stock = hl.stock_in_ikm + hl.stock_in_rs
             WHERE hl.id = ? AND hl.hospital_id = ?`,
            [item.hospital_linen_id, hospital_id]
          );
        } else {
          // Hospital has no rooms: directly update stock_in_rs
          await connection.query(
            "UPDATE mst_hospital_linen SET stock_in_rs = ?, current_stock = stock_in_ikm + ? WHERE id = ? AND hospital_id = ?",
            [item.stock_qty || 0, item.stock_qty || 0, item.hospital_linen_id, hospital_id]
          );
        }
      } else {
        // opname_type === "IKM" (Gudang)
        await connection.query(
          "UPDATE mst_hospital_linen SET stock_in_ikm = ?, current_stock = ? + stock_in_rs WHERE id = ? AND hospital_id = ?",
          [item.stock_qty || 0, item.stock_qty || 0, item.hospital_linen_id, hospital_id]
        );
      }
    }

    await connection.commit();

    res.status(201).json({
      success: true,
      message: "Stock opname berhasil disimpan",
      id: stock_opname_id
    });
  } catch (err) {
    if (connection) {
      await connection.rollback().catch(console.error);
    }
    console.error("[StockOpnameController] createStockOpname error:", err);
    res.status(500).json({ message: err.message || "Gagal menyimpan stock opname" });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}
