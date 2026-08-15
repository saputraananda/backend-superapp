import { safeIKMQuery } from "../../db/pool.js";

// GET all rooms
export const getAll = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT id, room_name, created_at, updated_at 
       FROM mst_rooms_ikm 
       ORDER BY room_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("masterRoomsIKMController.getAll:", err);
    res.status(500).json({ message: err.message });
  }
};

// CREATE room
export const create = async (req, res) => {
  const { room_name } = req.body;
  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }
  try {
    const [exist] = await safeIKMQuery(
      `SELECT id FROM mst_rooms_ikm WHERE room_name = ?`,
      [room_name.trim()]
    );
    if (exist.length > 0) {
      return res.status(400).json({ message: "Nama ruangan sudah digunakan" });
    }
    const [result] = await safeIKMQuery(
      `INSERT INTO mst_rooms_ikm (room_name) VALUES (?)`,
      [room_name.trim()]
    );
    res.status(201).json({ message: "Ruangan berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("masterRoomsIKMController.create:", err);
    res.status(500).json({ message: err.message });
  }
};

// UPDATE room
export const update = async (req, res) => {
  const { id } = req.params;
  const { room_name } = req.body;
  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }
  try {
    const [existName] = await safeIKMQuery(
      `SELECT id FROM mst_rooms_ikm WHERE room_name = ? AND id != ?`,
      [room_name.trim(), id]
    );
    if (existName.length > 0) {
      return res.status(400).json({ message: "Nama ruangan sudah digunakan" });
    }
    const [exist] = await safeIKMQuery(
      `SELECT id FROM mst_rooms_ikm WHERE id = ?`,
      [id]
    );
    if (exist.length === 0) {
      return res.status(404).json({ message: "Ruangan tidak ditemukan" });
    }
    await safeIKMQuery(
      `UPDATE mst_rooms_ikm SET room_name = ? WHERE id = ?`,
      [room_name.trim(), id]
    );
    res.json({ message: "Ruangan berhasil diperbarui" });
  } catch (err) {
    console.error("masterRoomsIKMController.update:", err);
    res.status(500).json({ message: err.message });
  }
};

// DELETE room
export const remove = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      `SELECT id FROM mst_rooms_ikm WHERE id = ?`,
      [id]
    );
    if (exist.length === 0) {
      return res.status(404).json({ message: "Ruangan tidak ditemukan" });
    }
    await safeIKMQuery(
      `DELETE FROM mst_rooms_ikm WHERE id = ?`,
      [id]
    );
    res.json({ message: "Ruangan berhasil dihapus" });
  } catch (err) {
    console.error("masterRoomsIKMController.remove:", err);
    res.status(500).json({ message: err.message });
  }
};
