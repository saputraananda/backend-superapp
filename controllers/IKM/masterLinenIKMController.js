// src/controllers/IKM/masterLinenIKMController.js
import { safeIKMQuery } from "../../db/pool.js";

const TABLE = "mst_linen";

export const getLinenList = async (req, res) => {
  try {
    const { page = 1, limit = 25, search = "", category_id = "" } = req.query;
    const pg = Math.max(1, Number(page) || 1);
    const lm = Math.max(1, Number(limit) || 25);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (search.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(l.linen_code LIKE ? OR l.linen_name LIKE ? OR l.description LIKE ? OR c.category_name LIKE ?)");
      params.push(like, like, like, like);
    }

    if (category_id) {
      where.push("l.category_id = ?");
      params.push(category_id);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total FROM ${TABLE} l LEFT JOIN mst_linen_category c ON l.category_id = c.id ${whereSql}`, params
    );

    const [rows] = await safeIKMQuery(
      `SELECT l.id, l.linen_code, l.linen_name, l.category_id, c.category_code, c.category_name, l.description, l.created_at, l.updated_at
       FROM ${TABLE} l LEFT JOIN mst_linen_category c ON l.category_id = c.id ${whereSql}
       ORDER BY l.linen_code ASC LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    res.json({
      data: rows,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) || 1 },
    });
  } catch (err) {
    console.error("getLinenList:", err);
    res.status(500).json({ message: err.message });
  }
};

export const getCategories = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT id, category_code, category_name, description, sort_order FROM mst_linen_category ORDER BY sort_order ASC, category_name ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error("getCategories:", err);
    res.status(500).json({ message: err.message });
  }
};

export const createLinen = async (req, res) => {
  try {
    const { linen_code, linen_name, category_id, description } = req.body;

    if (!linen_name?.trim()) {
      return res.status(400).json({ message: "Nama linen wajib diisi" });
    }

    if (category_id) {
      const [catExist] = await safeIKMQuery(
        `SELECT id FROM mst_linen_category WHERE id = ?`, [category_id]
      );
      if (catExist.length === 0) {
        return res.status(400).json({ message: "Kategori tidak valid" });
      }
    }

    const [dupName] = await safeIKMQuery(
      `SELECT id FROM ${TABLE} WHERE linen_name = ?`, [linen_name.trim()]
    );
    if (dupName.length > 0) {
      return res.status(409).json({ message: "Nama linen sudah ada" });
    }

    if (linen_code?.trim()) {
      const [dupCode] = await safeIKMQuery(
        `SELECT id FROM ${TABLE} WHERE linen_code = ?`, [linen_code.trim()]
      );
      if (dupCode.length > 0) {
        return res.status(409).json({ message: "Kode linen sudah ada" });
      }
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO ${TABLE} (linen_code, linen_name, category_id, description) VALUES (?, ?, ?, ?)`,
      [linen_code?.trim() || null, linen_name.trim(), category_id || null, description?.trim() || null]
    );

    res.status(201).json({ message: "Linen berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

export const updateLinen = async (req, res) => {
  try {
    const { id } = req.params;
    const { linen_code, linen_name, category_id, description } = req.body;

    if (!linen_name?.trim()) {
      return res.status(400).json({ message: "Nama linen wajib diisi" });
    }

    const [exist] = await safeIKMQuery(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (exist.length === 0) {
      return res.status(404).json({ message: "Linen tidak ditemukan" });
    }

    if (category_id) {
      const [catExist] = await safeIKMQuery(
        `SELECT id FROM mst_linen_category WHERE id = ?`, [category_id]
      );
      if (catExist.length === 0) {
        return res.status(400).json({ message: "Kategori tidak valid" });
      }
    }

    const [dupName] = await safeIKMQuery(
      `SELECT id FROM ${TABLE} WHERE linen_name = ? AND id != ?`,
      [linen_name.trim(), id]
    );
    if (dupName.length > 0) {
      return res.status(409).json({ message: "Nama linen sudah digunakan" });
    }

    if (linen_code?.trim()) {
      const [dupCode] = await safeIKMQuery(
        `SELECT id FROM ${TABLE} WHERE linen_code = ? AND id != ?`,
        [linen_code.trim(), id]
      );
      if (dupCode.length > 0) {
        return res.status(409).json({ message: "Kode linen sudah digunakan" });
      }
    }

    await safeIKMQuery(
      `UPDATE ${TABLE} SET linen_code = ?, linen_name = ?, category_id = ?, description = ? WHERE id = ?`,
      [linen_code?.trim() || null, linen_name.trim(), category_id || null, description?.trim() || null, id]
    );

    res.json({ message: "Linen berhasil diperbarui" });
  } catch (err) {
    console.error("updateLinen:", err);
    res.status(500).json({ message: err.message });
  }
};

export const deleteLinen = async (req, res) => {
  try {
    const { id } = req.params;

    const [exist] = await safeIKMQuery(`SELECT id FROM ${TABLE} WHERE id = ?`, [id]);
    if (exist.length === 0) {
      return res.status(404).json({ message: "Linen tidak ditemukan" });
    }

    const [used] = await safeIKMQuery(
      `SELECT COUNT(*) AS cnt FROM mst_hospital_linen WHERE linen_id = ?`, [id]
    );
    if (used[0]?.cnt > 0) {
      return res.status(409).json({
        message: `Linen masih digunakan oleh ${used[0].cnt} rumah sakit. Tidak bisa dihapus.`
      });
    }

    await safeIKMQuery(`DELETE FROM ${TABLE} WHERE id = ?`, [id]);
    res.json({ message: "Linen berhasil dihapus" });
  } catch (err) {
    console.error("deleteLinen:", err);
    res.status(500).json({ message: err.message });
  }
};
