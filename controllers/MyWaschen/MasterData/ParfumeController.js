import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "name", "price", "created_at"];

/** Harga parfum per item (0 = gratis) & outlet (kosong = semua outlet). */
async function parseParfumeExtras(body) {
  const price = body.price === "" || body.price == null ? 0 : Number(body.price);
  if (!Number.isFinite(price) || price < 0) return { error: "Harga parfum harus angka 0 atau lebih" };
  const outletId = body.outlet_id === "" || body.outlet_id == null ? null : Number(body.outlet_id);
  if (outletId !== null) {
    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) return { error: "Outlet tidak ditemukan" };
  }
  return { price, outletId };
}

export const getParfumes = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "name";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(p.name LIKE ? OR p.description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("p.is_active = ?");
      params.push(Number(isActive));
    }

    // outletId: "all" = hanya parfum semua outlet; angka = khusus outlet tsb
    const outletFilter = String(req.query.outletId || "").trim();
    if (outletFilter === "all") where.push("p.outlet_id IS NULL");
    else if (outletFilter) {
      where.push("p.outlet_id = ?");
      params.push(Number(outletFilter));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT p.*, o.name AS outlet_name
       FROM mst_parfume p
       LEFT JOIN mst_outlet o ON o.id = p.outlet_id
       ${whereSql}
       ORDER BY p.${sortBy} ${sortDir}, p.name ASC`,
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
    const extras = await parseParfumeExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_parfume WHERE name = ?", [name.trim()]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Nama parfum "${name.trim()}" sudah ada` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_parfume (name, description, price, outlet_id, is_active) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), description?.trim() || null, extras.price, extras.outletId, is_active !== undefined ? Number(is_active) : 1]
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
    const extras = await parseParfumeExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_parfume WHERE name = ? AND id != ?",
      [name.trim(), id]
    );
    if (dup.length) {
      return res.status(400).json({ success: false, message: `Nama parfum "${name.trim()}" sudah ada` });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_parfume
       SET name = ?, description = ?, price = ?, outlet_id = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [name.trim(), description?.trim() || null, extras.price, extras.outletId, is_active !== undefined ? Number(is_active) : 1, id]
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
      `SELECT id FROM tr_transaction WHERE parfume_id = ?
       UNION ALL SELECT id FROM tr_transaction_detail WHERE parfume_id = ? LIMIT 1`,
      [id, id]
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
