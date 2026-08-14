import { safeIKMQuery } from "../../db/pool.js";

// ── Reusable helpers ──
const hospitalNotFound = (hospitalId) => `Data linen RS tidak ditemukan`;

// ── GET all hospital_linen for a given hospital ──
export const getByHospital = async (req, res) => {
  const { hospitalId } = req.params;
  try {
    const [rows] = await safeIKMQuery(
      `SELECT hl.id, hl.hospital_id, hl.linen_id, hl.hospital_linen_name,
              hl.ownership_type, hl.unit, hl.grammage,
              hl.washing_price_type, hl.washing_price, hl.rental_price,
              hl.par_stock, hl.min_stock, hl.stock_in_ikm, hl.stock_in_rs, hl.current_stock, hl.is_active,
              hl.created_at, hl.updated_at,
              l.linen_code,
              l.linen_name AS master_linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM mst_hospital_linen hl
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE hl.hospital_id = ?
       ORDER BY l.linen_name ASC`,
      [hospitalId]
    );

    // Fetch room stocks
    const [roomStocks] = await safeIKMQuery(
      `SELECT hlr.id, hlr.hospital_linen_id, hlr.room_id, hlr.stock_in_rs, r.room_name
       FROM mst_hospital_linen_rooms hlr
       JOIN mst_rooms_rs r ON hlr.room_id = r.id`
    );

    // Fetch all IKM rooms
    const [ikmRooms] = await safeIKMQuery(
      `SELECT id, room_name FROM mst_rooms_ikm ORDER BY room_name ASC`
    );

    // Fetch IKM room stocks
    const [ikmRoomStocks] = await safeIKMQuery(
      `SELECT milr.id, milr.hospital_linen_id, milr.room_ikm_id, milr.stock_in_ikm, r.room_name AS ikm_room_name
       FROM mst_ikm_linen_rooms milr
       JOIN mst_rooms_ikm r ON milr.room_ikm_id = r.id`
    );

    // Group by hospital_linen_id for RS
    const roomStocksMap = {};
    roomStocks.forEach(rs => {
      if (!roomStocksMap[rs.hospital_linen_id]) roomStocksMap[rs.hospital_linen_id] = [];
      roomStocksMap[rs.hospital_linen_id].push({
        id: rs.id,
        room_id: rs.room_id,
        room_name: rs.room_name,
        stock_in_rs: rs.stock_in_rs
      });
    });

    // Group by hospital_linen_id for IKM
    const ikmRoomStocksMap = {};
    ikmRoomStocks.forEach(irs => {
      if (!ikmRoomStocksMap[irs.hospital_linen_id]) ikmRoomStocksMap[irs.hospital_linen_id] = [];
      ikmRoomStocksMap[irs.hospital_linen_id].push({
        id: irs.id,
        room_ikm_id: irs.room_ikm_id,
        ikm_room_name: irs.ikm_room_name,
        stock_in_ikm: irs.stock_in_ikm
      });
    });

    const data = rows.map(r => ({
      ...r,
      room_stocks: roomStocksMap[r.id] || [],
      ikm_room_stocks: ikmRoomStocksMap[r.id] || []
    }));

    res.json({ data, ikm_rooms: ikmRooms });
  } catch (err) {
    console.error("getByHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET all mst_linen (for dropdown) ──
export const getAllLinen = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM mst_linen l
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       ORDER BY l.linen_name ASC`
    );
    const mapped = rows.map(r => ({
      id: r.id,
      linen_code: r.linen_code,
      linen_name: [r.linen_name, r.size_name, r.color_name, r.material_name].filter(Boolean).join(" "),
    }));
    res.json({ data: mapped });
  } catch (err) {
    console.error("getAllLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── CREATE hospital_linen ──
export const create = async (req, res) => {
  const { hospitalId } = req.params;
  const {
    linen_id, hospital_linen_name, ownership_type, unit, grammage,
    washing_price_type, washing_price, rental_price, par_stock, min_stock,
    stock_in_ikm, stock_in_rs, is_active, room_stocks, ikm_room_stocks,
  } = req.body;

  if (!linen_id) return res.status(400).json({ message: "Linen wajib dipilih" });

  const totalIkmStock = Array.isArray(ikm_room_stocks) && ikm_room_stocks.length > 0
    ? ikm_room_stocks.reduce((sum, r) => sum + (Number(r.stock_in_ikm) || 0), 0)
    : Number(stock_in_ikm) || 0;

  const totalRsStock = Array.isArray(room_stocks) && room_stocks.length > 0
    ? room_stocks.reduce((sum, r) => sum + (Number(r.stock_in_rs) || 0), 0)
    : Number(stock_in_rs) || 0;

  const currentStock = totalIkmStock + totalRsStock;

  try {
    const [result] = await safeIKMQuery(
      `INSERT INTO mst_hospital_linen
       (hospital_id, linen_id, hospital_linen_name, ownership_type, unit, grammage,
        washing_price_type, washing_price, rental_price, par_stock, min_stock,
        stock_in_ikm, stock_in_rs, current_stock, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospitalId, linen_id,
        hospital_linen_name?.trim() || null,
        ownership_type || "MILIK_RS",
        unit || "PCS",
        grammage || null,
        washing_price_type || "PCS",
        washing_price ?? 0,
        rental_price ?? 0,
        par_stock ?? 0,
        min_stock ?? 0,
        totalIkmStock,
        totalRsStock,
        currentStock,
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
      ]
    );

    // Save room stocks
    if (Array.isArray(room_stocks) && room_stocks.length > 0) {
      for (const r of room_stocks) {
        if (r.room_id) {
          await safeIKMQuery(
            `INSERT INTO mst_hospital_linen_rooms (hospital_linen_id, room_id, stock_in_rs) VALUES (?, ?, ?)`,
            [result.insertId, r.room_id, Number(r.stock_in_rs) || 0]
          );
        }
      }
    }

    // Save IKM room stocks
    if (Array.isArray(ikm_room_stocks) && ikm_room_stocks.length > 0) {
      for (const r of ikm_room_stocks) {
        if (r.room_ikm_id) {
          await safeIKMQuery(
            `INSERT INTO mst_ikm_linen_rooms (hospital_linen_id, room_ikm_id, stock_in_ikm) VALUES (?, ?, ?)`,
            [result.insertId, r.room_ikm_id, Number(r.stock_in_ikm) || 0]
          );
        }
      }
    }

    res.status(201).json({ message: "Linen RS berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("create:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE hospital_linen ──
export const update = async (req, res) => {
  const { hospitalId, id } = req.params;
  const {
    linen_id, hospital_linen_name, ownership_type, unit, grammage,
    washing_price_type, washing_price, rental_price, par_stock, min_stock,
    stock_in_ikm, stock_in_rs, is_active, room_stocks, ikm_room_stocks,
  } = req.body;

  try {
    const [exist] = await safeIKMQuery(
      `SELECT id FROM mst_hospital_linen WHERE id = ? AND hospital_id = ?`,
      [id, hospitalId]
    );
    if (exist.length === 0) {
      return res.status(404).json({ message: hospitalNotFound(hospitalId) });
    }

    const ikmStock = Array.isArray(ikm_room_stocks) && ikm_room_stocks.length > 0
      ? ikm_room_stocks.reduce((sum, r) => sum + (Number(r.stock_in_ikm) || 0), 0)
      : (stock_in_ikm !== undefined ? Number(stock_in_ikm) : 0);

    const totalRsStock = Array.isArray(room_stocks) && room_stocks.length > 0
      ? room_stocks.reduce((sum, r) => sum + (Number(r.stock_in_rs) || 0), 0)
      : Number(stock_in_rs) || 0;
    const currentStock = ikmStock + totalRsStock;

    await safeIKMQuery(
      `UPDATE mst_hospital_linen SET
        linen_id = ?, hospital_linen_name = ?, ownership_type = ?, unit = ?,
        grammage = ?, washing_price_type = ?, washing_price = ?, rental_price = ?,
        par_stock = ?, min_stock = ?, stock_in_ikm = ?, stock_in_rs = ?,
        current_stock = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        linen_id ?? exist[0].linen_id,
        hospital_linen_name?.trim() || null,
        ownership_type || "MILIK_RS",
        unit || "PCS",
        grammage || null,
        washing_price_type || "PCS",
        washing_price ?? 0,
        rental_price ?? 0,
        par_stock ?? 0,
        min_stock ?? 0,
        ikmStock,
        totalRsStock,
        currentStock,
        is_active !== undefined ? (is_active ? 1 : 0) : 1,
        id,
      ]
    );

    // Update room stocks
    await safeIKMQuery(`DELETE FROM mst_hospital_linen_rooms WHERE hospital_linen_id = ?`, [id]);
    if (Array.isArray(room_stocks) && room_stocks.length > 0) {
      for (const r of room_stocks) {
        if (r.room_id) {
          await safeIKMQuery(
            `INSERT INTO mst_hospital_linen_rooms (hospital_linen_id, room_id, stock_in_rs) VALUES (?, ?, ?)`,
            [id, r.room_id, Number(r.stock_in_rs) || 0]
          );
        }
      }
    }

    // Update IKM room stocks
    await safeIKMQuery(`DELETE FROM mst_ikm_linen_rooms WHERE hospital_linen_id = ?`, [id]);
    if (Array.isArray(ikm_room_stocks) && ikm_room_stocks.length > 0) {
      for (const r of ikm_room_stocks) {
        if (r.room_ikm_id) {
          await safeIKMQuery(
            `INSERT INTO mst_ikm_linen_rooms (hospital_linen_id, room_ikm_id, stock_in_ikm) VALUES (?, ?, ?)`,
            [id, r.room_ikm_id, Number(r.stock_in_ikm) || 0]
          );
        }
      }
    }

    res.json({ message: "Linen RS berhasil diperbarui" });
  } catch (err) {
    console.error("update:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE hospital_linen ──
export const remove = async (req, res) => {
  const { hospitalId, id } = req.params;
  try {
    await safeIKMQuery(
      `DELETE FROM mst_hospital_linen WHERE id = ? AND hospital_id = ?`,
      [id, hospitalId]
    );
    res.json({ message: "Linen RS berhasil dihapus" });
  } catch (err) {
    console.error("remove:", err);
    res.status(500).json({ message: err.message });
  }
};
