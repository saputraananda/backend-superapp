import { safeIKMQuery } from "../../db/pool.js";

const parseCoord = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

// ── GET ALL ────────────────────────────────────────────────────────────────
export const getHospitals = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT id, hospital_name, hospital_id, company_name, address,
              latitude, longitude, username, password, username_unit, password_unit, created_at, updated_at
       FROM mst_hospital
       ORDER BY hospital_name ASC`
    );

    // Fetch all rooms
    const [roomRows] = await safeIKMQuery(
      `SELECT id, hospital_id, room_name FROM mst_rooms_rs ORDER BY room_name ASC`
    );

    // Map rooms to hospitals
    const roomsMap = {};
    roomRows.forEach((r) => {
      if (!roomsMap[r.hospital_id]) roomsMap[r.hospital_id] = [];
      roomsMap[r.hospital_id].push(r);
    });

    const data = rows.map((h) => ({
      ...h,
      rooms: roomsMap[h.id] || [],
    }));

    res.json({ data });
  } catch (err) {
    console.error("getHospitals:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── CREATE ─────────────────────────────────────────────────────────────────
export const createHospital = async (req, res) => {
  const { hospital_name, hospital_id, company_name, address, latitude, longitude, username, password, username_unit, password_unit, rooms } = req.body;

  if (!hospital_name?.trim())
    return res.status(400).json({ message: "Nama rumah sakit wajib diisi" });

  try {
    const [dupName] = await safeIKMQuery(
      `SELECT id FROM mst_hospital WHERE hospital_name = ?`, [hospital_name.trim()]
    );
    if (dupName.length > 0)
      return res.status(409).json({ message: "Nama rumah sakit sudah terdaftar" });

    if (hospital_id?.trim()) {
      const [dupId] = await safeIKMQuery(
        `SELECT id FROM mst_hospital WHERE hospital_id = ?`, [hospital_id.trim()]
      );
      if (dupId.length > 0)
        return res.status(409).json({ message: "Hospital ID sudah digunakan" });
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO mst_hospital (hospital_name, hospital_id, company_name, address, latitude, longitude, username, password, username_unit, password_unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
        username?.trim() || null,
        password || null,
        username_unit?.trim() || null,
        password_unit || null,
      ]
    );

    // Save rooms
    if (Array.isArray(rooms) && rooms.length > 0) {
      for (const room of rooms) {
        const name = (typeof room === "object" && room !== null ? room.room_name : room)?.trim();
        if (name) {
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name) VALUES (?, ?)`,
            [result.insertId, name]
          );
        }
      }
    }

    res.status(201).json({ message: "Rumah sakit berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE ─────────────────────────────────────────────────────────────────
export const updateHospital = async (req, res) => {
  const { id } = req.params;
  const { hospital_name, hospital_id, company_name, address, latitude, longitude, username, password, username_unit, password_unit, rooms } = req.body;

  if (!hospital_name?.trim())
    return res.status(400).json({ message: "Nama rumah sakit wajib diisi" });

  try {
    const [exist] = await safeIKMQuery(`SELECT id FROM mst_hospital WHERE id = ?`, [id]);
    if (exist.length === 0)
      return res.status(404).json({ message: "Rumah sakit tidak ditemukan" });

    const [dupName] = await safeIKMQuery(
      `SELECT id FROM mst_hospital WHERE hospital_name = ? AND id != ?`, [hospital_name.trim(), id]
    );
    if (dupName.length > 0)
      return res.status(409).json({ message: "Nama rumah sakit sudah digunakan" });

    if (hospital_id?.trim()) {
      const [dupId] = await safeIKMQuery(
        `SELECT id FROM mst_hospital WHERE hospital_id = ? AND id != ?`, [hospital_id.trim(), id]
      );
      if (dupId.length > 0)
        return res.status(409).json({ message: "Hospital ID sudah digunakan" });
    }

    await safeIKMQuery(
      `UPDATE mst_hospital
       SET hospital_name=?, hospital_id=?, company_name=?, address=?,
           latitude=?, longitude=?, username=?, password=?, username_unit=?, password_unit=?, updated_at=NOW()
       WHERE id=?`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
        username?.trim() || null,
        password || null,
        username_unit?.trim() || null,
        password_unit || null,
        id,
      ]
    );

    // Update rooms safely to keep existing room IDs
    if (Array.isArray(rooms)) {
      // Find all existing room IDs in database for this hospital
      const [existingRows] = await safeIKMQuery(
        `SELECT id FROM mst_rooms_rs WHERE hospital_id = ?`,
        [id]
      );
      const existingIds = existingRows.map((r) => r.id);
      const keepIds = [];

      for (const room of rooms) {
        const isObj = typeof room === "object" && room !== null;
        const name = (isObj ? room.room_name : room)?.trim();
        if (!name) continue;

        const roomId = isObj ? room.id : null;

        if (roomId && existingIds.includes(Number(roomId))) {
          // Update existing room
          await safeIKMQuery(
            `UPDATE mst_rooms_rs 
             SET room_name = ? 
             WHERE id = ?`,
            [name, roomId]
          );
          keepIds.push(Number(roomId));
        } else {
          // Insert new room
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name) 
             VALUES (?, ?)`,
            [id, name]
          );
        }
      }

      // Delete rooms that are not in the update request
      const deleteIds = existingIds.filter((eid) => !keepIds.includes(eid));
      if (deleteIds.length > 0) {
        await safeIKMQuery(
          `DELETE FROM mst_rooms_rs WHERE id IN (?)`,
          [deleteIds]
        );
      }
    } else {
      await safeIKMQuery(`DELETE FROM mst_rooms_rs WHERE hospital_id = ?`, [id]);
    }

    res.json({ message: "Rumah sakit berhasil diperbarui" });
  } catch (err) {
    console.error("updateHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE ─────────────────────────────────────────────────────────────────
export const deleteHospital = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(`SELECT id FROM mst_hospital WHERE id = ?`, [id]);
    if (exist.length === 0)
      return res.status(404).json({ message: "Rumah sakit tidak ditemukan" });

    await safeIKMQuery(`DELETE FROM mst_hospital WHERE id = ?`, [id]);
    res.json({ message: "Rumah sakit berhasil dihapus" });
  } catch (err) {
    console.error("deleteHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── ROOM OPERATIONS ────────────────────────────────────────────────────────
export const createRoom = async (req, res) => {
  const { hospitalId } = req.params;
  const { room_name } = req.body;

  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }

  try {
    const [result] = await safeIKMQuery(
      `INSERT INTO mst_rooms_rs (hospital_id, room_name) VALUES (?, ?)`,
      [hospitalId, room_name.trim()]
    );
    res.status(201).json({ message: "Ruangan berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createRoom:", err);
    res.status(500).json({ message: err.message });
  }
};

export const updateRoom = async (req, res) => {
  const { roomId } = req.params;
  const { room_name } = req.body;

  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }

  try {
    await safeIKMQuery(
      `UPDATE mst_rooms_rs SET room_name = ? WHERE id = ?`,
      [room_name.trim(), roomId]
    );
    res.json({ message: "Nama ruangan berhasil diperbarui" });
  } catch (err) {
    console.error("updateRoom:", err);
    res.status(500).json({ message: err.message });
  }
};

export const deleteRoom = async (req, res) => {
  const { roomId } = req.params;

  try {
    await safeIKMQuery(
      `DELETE FROM mst_rooms_rs WHERE id = ?`,
      [roomId]
    );
    res.json({ message: "Ruangan berhasil dihapus" });
  } catch (err) {
    console.error("deleteRoom:", err);
    res.status(500).json({ message: err.message });
  }
};
