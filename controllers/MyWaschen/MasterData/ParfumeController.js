import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "name", "created_at"];

export const getParfumes = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "name";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(name LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_parfume ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getParfumes error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getParfumeById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_parfume WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Parfum tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getParfumeById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createParfume = async (req, res) => {
  try {
    const { name, description, is_active } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Aroma Parfum wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_parfume WHERE name = ?", [name.trim()]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Nama parfum "${name.trim()}" sudah ada` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_parfume (name, description, is_active) VALUES (?, ?, ?)`,
      [name.trim(), description?.trim() || null, is_active !== undefined ? Number(is_active) : 1]
    );

    res.status(201).json({ success: true, message: "Parfum berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createParfume error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateParfume = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, is_active } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Aroma Parfum wajib diisi" });
    }

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_parfume WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Parfum tidak ditemukan" });
    }

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_parfume WHERE name = ? AND id != ?",
      [name.trim(), id]
    );
    if (dup.length) {
      return res.status(400).json({ success: false, message: `Nama parfum "${name.trim()}" sudah ada` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_parfume
       SET name = ?, description = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [name.trim(), description?.trim() || null, is_active !== undefined ? Number(is_active) : 1, id]
    );

    res.json({ success: true, message: "Parfum berhasil diperbarui" });
  } catch (err) {
    console.error("updateParfume error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteParfume = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_parfume WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Parfum tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction WHERE parfume_id = ? LIMIT 1",
      [id]
    );
    if (used.length) {
      return res.status(400).json({
        success: false,
        message: "Parfum tidak dapat dihapus karena sudah digunakan pada transaksi",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_parfume WHERE id = ?", [id]);
    res.json({ success: true, message: "Parfum berhasil dihapus" });
  } catch (err) {
    console.error("deleteParfume error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
