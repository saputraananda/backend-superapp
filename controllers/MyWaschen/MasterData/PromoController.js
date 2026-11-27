import { safeMyWaschenQuery, myWaschenPool } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "discount_type", "sort_order", "created_at"];
const DISCOUNT_TYPES = ["none", "percentage", "nominal"];
const MEMBER_TIERS = ["Gold", "Platinum", "Diamond"];

// Batas maksimal potongan (Rp): kosong/0/negatif = tanpa batas (NULL).
const maxDiscountOf = (v) => {
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) || n <= 0 ? null : n;
};

/** Tier member (SET): array/string "Gold,Diamond" -> "Gold,Diamond"; kosong = NULL (semua customer). */
const memberTiersOf = (v) => {
  const list = (Array.isArray(v) ? v : String(v || "").split(",")).map((x) => String(x).trim());
  const picked = MEMBER_TIERS.filter((t) => list.includes(t));
  return picked.length ? picked.join(",") : null;
};

/** Daftar id layanan promo. undefined = tidak dikirim (jangan ubah); [] = semua layanan. */
const serviceIdsOf = (v) => {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : String(v || "").split(",");
  return [...new Set(list.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
};

/** Field promo Phase 20: outlet, tier member, otomatis, wajib potong saldo, layanan. */
async function parsePromoExtras(body) {
  const outletId = body.outlet_id === "" || body.outlet_id == null ? null : Number(body.outlet_id);
  if (outletId !== null) {
    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ?", [outletId]);
    if (!outlet.length) return { error: "Outlet tidak ditemukan" };
  }
  const serviceIds = serviceIdsOf(body.service_ids);
  if (serviceIds?.length) {
    const [found] = await safeMyWaschenQuery("SELECT id FROM mst_service WHERE id IN (?)", [serviceIds]);
    if (found.length !== serviceIds.length) return { error: "Ada layanan promo yang tidak ditemukan" };
  }
  return {
    outletId,
    memberTiers: memberTiersOf(body.member_tiers),
    isAuto: Number(body.is_auto) === 1 ? 1 : 0,
    requiresMemberBalance: Number(body.requires_member_balance) === 1 ? 1 : 0,
    serviceIds,
  };
}

/** Ganti seluruh baris mst_promo_service milik promo (di dalam transaksi DB pemanggil). */
async function replacePromoServices(conn, promoId, serviceIds) {
  if (serviceIds === undefined) return;
  await conn.query("DELETE FROM mst_promo_service WHERE promo_id = ?", [promoId]);
  if (serviceIds.length) {
    await conn.query("INSERT INTO mst_promo_service (promo_id, service_id) VALUES ?", [
      serviceIds.map((sid) => [promoId, sid]),
    ]);
  }
}

const rollbackQuietly = async (conn) => {
  if (!conn) return;
  try { await conn.rollback(); } catch { /* belum ada transaksi */ }
};

const toIdList = (csv) => (csv ? String(csv).split(",").map(Number).filter(Boolean) : []);

export const getPromos = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const discountType = req.query.discountType;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "sort_order";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(p.code LIKE ? OR p.name LIKE ? OR p.description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("p.is_active = ?");
      params.push(Number(isActive));
    }

    if (discountType && DISCOUNT_TYPES.includes(discountType)) {
      where.push("p.discount_type = ?");
      params.push(discountType);
    }

    if (req.query.isAuto !== undefined && req.query.isAuto !== "") {
      where.push("p.is_auto = ?");
      params.push(Number(req.query.isAuto) === 1 ? 1 : 0);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT p.*, o.name AS outlet_name,
              (SELECT GROUP_CONCAT(ps.service_id ORDER BY ps.service_id) FROM mst_promo_service ps
               WHERE ps.promo_id = p.id) AS service_ids_csv,
              (SELECT GROUP_CONCAT(s.name ORDER BY s.name SEPARATOR ', ') FROM mst_promo_service ps
               JOIN mst_service s ON s.id = ps.service_id WHERE ps.promo_id = p.id) AS service_names
       FROM mst_promo p
       LEFT JOIN mst_outlet o ON o.id = p.outlet_id
       ${whereSql}
       ORDER BY p.${sortBy} ${sortDir}, p.name ASC`,
      params
    );

    const data = rows.map(({ service_ids_csv, ...r }) => ({ ...r, service_ids: toIdList(service_ids_csv) }));
    res.json({ success: true, data });
  } catch (err) {
    console.error("getPromos error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPromoById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_promo WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }
    const [svc] = await safeMyWaschenQuery(
      "SELECT service_id FROM mst_promo_service WHERE promo_id = ? ORDER BY service_id",
      [id]
    );
    res.json({ success: true, data: { ...rows[0], service_ids: svc.map((r) => Number(r.service_id)) } });
  } catch (err) {
    console.error("getPromoById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPromo = async (req, res) => {
  let conn;
  try {
    const { code, name, discount_type, discount_value, max_discount, description, sort_order, is_active } = req.body;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ success: false, message: "Kode dan Nama promo wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const discType = DISCOUNT_TYPES.includes(discount_type) ? discount_type : "none";

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const extras = await parsePromoExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    conn = await myWaschenPool.getConnection();
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO mst_promo
         (code, name, discount_type, discount_value, max_discount, outlet_id, member_tiers, is_auto,
          requires_member_balance, description, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        discType,
        discount_value !== undefined ? Number(discount_value) : 0,
        maxDiscountOf(max_discount),
        extras.outletId,
        extras.memberTiers,
        extras.isAuto,
        extras.requiresMemberBalance,
        description?.trim() || null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );
    await replacePromoServices(conn, result.insertId, extras.serviceIds);
    await conn.commit();

    res.status(201).json({ success: true, message: "Promo berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    await rollbackQuietly(conn);
    console.error("createPromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn?.release();
  }
};

export const updatePromo = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const { code, name, discount_type, discount_value, max_discount, description, sort_order, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama promo wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE code = ? AND id != ?", [formattedCode, id]);
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    const discType = DISCOUNT_TYPES.includes(discount_type) ? discount_type : "none";
    const extras = await parsePromoExtras(req.body);
    if (extras.error) return res.status(400).json({ success: false, message: extras.error });

    conn = await myWaschenPool.getConnection();
    await conn.beginTransaction();
    await conn.query(
      `UPDATE mst_promo
       SET code = COALESCE(?, code), name = ?, discount_type = ?, discount_value = ?, max_discount = ?,
           outlet_id = ?, member_tiers = ?, is_auto = ?, requires_member_balance = ?,
           description = ?, sort_order = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        discType,
        discount_value !== undefined ? Number(discount_value) : 0,
        maxDiscountOf(max_discount),
        extras.outletId,
        extras.memberTiers,
        extras.isAuto,
        extras.requiresMemberBalance,
        description?.trim() || null,
        sort_order !== undefined ? Number(sort_order) : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );
    await replacePromoServices(conn, Number(id), extras.serviceIds);
    await conn.commit();

    res.json({ success: true, message: "Promo berhasil diperbarui" });
  } catch (err) {
    await rollbackQuietly(conn);
    console.error("updatePromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn?.release();
  }
};

export const deletePromo = async (req, res) => {
  let conn;
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_promo WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Promo tidak ditemukan" });
    }

    conn = await myWaschenPool.getConnection();
    await conn.beginTransaction();
    await conn.query("DELETE FROM mst_promo_service WHERE promo_id = ?", [id]);
    await conn.query("DELETE FROM mst_promo WHERE id = ?", [id]);
    await conn.commit();
    res.json({ success: true, message: "Promo berhasil dihapus" });
  } catch (err) {
    await rollbackQuietly(conn);
    console.error("deletePromo error:", err);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    conn?.release();
  }
};
