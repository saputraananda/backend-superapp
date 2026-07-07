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
              latitude, longitude, created_at, updated_at
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
  const { hospital_name, hospital_id, company_name, address, latitude, longitude, rooms } = req.body;

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
      `INSERT INTO mst_hospital (hospital_name, hospital_id, company_name, address, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
      ]
    );

    // Save rooms
    if (Array.isArray(rooms) && rooms.length > 0) {
      for (const room of rooms) {
        if (room?.trim()) {
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name) VALUES (?, ?)`,
            [result.insertId, room.trim()]
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
  const { hospital_name, hospital_id, company_name, address, latitude, longitude, rooms } = req.body;

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
           latitude=?, longitude=?, updated_at=NOW()
       WHERE id=?`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
        id,
      ]
    );

    // Update rooms
    await safeIKMQuery(`DELETE FROM mst_rooms_rs WHERE hospital_id = ?`, [id]);
    if (Array.isArray(rooms) && rooms.length > 0) {
      for (const room of rooms) {
        if (room?.trim()) {
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name) VALUES (?, ?)`,
            [id, room.trim()]
          );
        }
      }
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
