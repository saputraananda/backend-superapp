import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "name", "sort_order", "created_at"];

const parseBody = (body) => ({
  name: String(body?.name || "").trim().slice(0, 100),
  is_active: Number(body?.is_active) === 0 ? 0 : 1,
  sort_order: Math.min(Math.max(Number.parseInt(body?.sort_order, 10) || 0, 0), 9999),
});

export const getItemKgs = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "sort_order";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];
    if (search) {
      where.push("name LIKE ?");
      params.push(`%${search}%`);
    }
    if (isActive === "0" || isActive === "1") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_item_kg ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getItemKgs error:", err);
    res.status(500).json({ success: false, message: "Gagal memuat item kiloan" });
  }
};

export const createItemKg = async (req, res) => {
  try {
    const { name, is_active, sort_order } = parseBody(req.body);
    if (!name) return res.status(400).json({ success: false, message: "Nama item wajib diisi" });

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_item_kg WHERE name = ?", [name]);
    if (exist.length) return res.status(400).json({ success: false, message: `Item "${name}" sudah ada` });

    const [result] = await safeMyWaschenQuery(
      "INSERT INTO mst_item_kg (name, is_active, sort_order) VALUES (?, ?, ?)",
      [name, is_active, sort_order]
    );
    res.status(201).json({ success: true, message: "Item berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createItemKg error:", err);
    res.status(500).json({ success: false, message: "Gagal menambahkan item" });
  }
};

export const updateItemKg = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { name, is_active, sort_order } = parseBody(req.body);
    if (!id) return res.status(400).json({ success: false, message: "ID tidak valid" });
    if (!name) return res.status(400).json({ success: false, message: "Nama item wajib diisi" });

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_item_kg WHERE id = ?", [id]);
    if (!exist.length) return res.status(404).json({ success: false, message: "Item tidak ditemukan" });

    const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_item_kg WHERE name = ? AND id != ?", [name, id]);
    if (dup.length) return res.status(400).json({ success: false, message: `Item "${name}" sudah ada` });

    await safeMyWaschenQuery(
      "UPDATE mst_item_kg SET name = ?, is_active = ?, sort_order = ? WHERE id = ?",
      [name, is_active, sort_order, id]
    );
    res.json({ success: true, message: "Item berhasil diperbarui" });
  } catch (err) {
    console.error("updateItemKg error:", err);
    res.status(500).json({ success: false, message: "Gagal memperbarui item" });
  }
};

export const deleteItemKg = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_item_kg WHERE id = ?", [id]);
    if (!exist.length) return res.status(404).json({ success: false, message: "Item tidak ditemukan" });

    const [used] = await safeMyWaschenQuery("SELECT id FROM tr_item_kg_detail WHERE item_kg_id = ? LIMIT 1", [id]);
    if (used.length) {
      return res.status(400).json({
        success: false,
        message: "Item sudah dipakai di rincian QC. Nonaktifkan saja agar riwayat tetap utuh.",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_item_kg WHERE id = ?", [id]);
    res.json({ success: true, message: "Item berhasil dihapus" });
  } catch (err) {
    console.error("deleteItemKg error:", err);
    res.status(500).json({ success: false, message: "Gagal menghapus item" });
  }
};
