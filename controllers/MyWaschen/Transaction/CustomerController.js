import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = [
  "id", "customer_code", "name", "phone", "email", "city",
  "total_orders", "total_spent", "deposit_balance", "monthly_spending", "created_at",
];

const CUSTOMER_SELECT = `
  SELECT c.*,
         o.outlet_code AS preferred_outlet_code,
         o.name AS preferred_outlet_name,
         o.full_name AS preferred_outlet_full_name,
         ct.code AS spending_tier_code,
         ct.name AS spending_tier_name,
         ct.label AS spending_tier_label,
         cs.code AS customer_source_code,
         cs.name AS customer_source_name,
         cs.label AS customer_source_label
  FROM mst_customer c
  LEFT JOIN mst_outlet o ON o.id = c.preferred_outlet_id
  LEFT JOIN mst_customer_tier ct ON ct.id = c.spending_tier_id
  LEFT JOIN mst_customer_source cs ON cs.id = c.customer_source_id
`;

/** Format: CUS{outlet_code}{YYMM}{sequence 4 digit} — contoh CUSCG26080001 */
async function generateCustomerCode(outletId) {
  let outletCode = "XX";
  if (outletId) {
    const [outlets] = await safeMyWaschenQuery(
      "SELECT outlet_code FROM mst_outlet WHERE id = ? LIMIT 1",
      [outletId]
    );
    if (outlets.length && outlets[0].outlet_code) {
      outletCode = String(outlets[0].outlet_code).toUpperCase();
    }
  }

  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CUS${outletCode}${yy}${mm}`;

  const [rows] = await safeMyWaschenQuery(
    "SELECT customer_code FROM mst_customer WHERE customer_code LIKE ? ORDER BY customer_code DESC LIMIT 1",
    [`${prefix}%`]
  );

  let nextSeq = 1;
  if (rows.length && rows[0].customer_code) {
    const last = String(rows[0].customer_code);
    const seqPart = last.slice(prefix.length);
    const parsed = parseInt(seqPart, 10);
    if (Number.isFinite(parsed)) nextSeq = parsed + 1;
  }

  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export const getCustomers = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const spendingTierId = req.query.spendingTierId;
    const customerSourceId = req.query.customerSourceId;
    const preferredOutletId = req.query.preferredOutletId;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "id";
    const sortDir = String(req.query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const where = [];
    const params = [];

    if (search) {
      where.push(
        `(c.customer_code LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?
          OR c.address LIKE ? OR c.city LIKE ? OR c.landmark LIKE ? OR c.home_branch LIKE ?)`
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like, like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("c.is_active = ?");
      params.push(Number(isActive));
    }

    if (spendingTierId) {
      where.push("c.spending_tier_id = ?");
      params.push(Number(spendingTierId));
    }

    if (customerSourceId) {
      where.push("c.customer_source_id = ?");
      params.push(Number(customerSourceId));
    }

    if (preferredOutletId) {
      where.push("c.preferred_outlet_id = ?");
      params.push(Number(preferredOutletId));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `${CUSTOMER_SELECT} ${whereSql} ORDER BY c.${sortBy} ${sortDir}`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getCustomers error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery(`${CUSTOMER_SELECT} WHERE c.id = ?`, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getCustomerById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createCustomer = async (req, res) => {
  try {
    const {
      customer_code, name, phone, email, address, city, postal_code, landmark, home_branch,
      preferred_outlet_id, spending_tier_id, customer_source_id,
      notes, is_active,
    } = req.body;

    if (!name?.trim() || !phone?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Nomor Telepon wajib diisi" });
    }

    const preferredOutletId = normalizeOptionalId(preferred_outlet_id);
    const code = customer_code?.trim() || (await generateCustomerCode(preferredOutletId));

    const [existCode] = await safeMyWaschenQuery("SELECT id FROM mst_customer WHERE customer_code = ?", [code]);
    if (existCode.length) {
      return res.status(400).json({ success: false, message: `Kode pelanggan "${code}" sudah digunakan` });
    }

    const [existPhone] = await safeMyWaschenQuery("SELECT id FROM mst_customer WHERE phone = ?", [phone.trim()]);
    if (existPhone.length) {
      return res.status(400).json({ success: false, message: "Nomor telepon sudah terdaftar" });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_customer (
        customer_code, name, phone, email, address, city, postal_code, landmark, home_branch,
        preferred_outlet_id, spending_tier_id, customer_source_id, notes, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        name.trim(),
        phone.trim(),
        email?.trim() || null,
        address?.trim() || null,
        city?.trim() || null,
        postal_code?.trim() || null,
        landmark?.trim() || null,
        home_branch?.trim() || null,
        preferredOutletId,
        normalizeOptionalId(spending_tier_id),
        normalizeOptionalId(customer_source_id),
        notes?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({
      success: true,
      message: "Pelanggan berhasil ditambahkan",
      id: result.insertId,
      customer_code: code,
    });
  } catch (err) {
    console.error("createCustomer error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      customer_code, name, phone, email, address, city, postal_code, landmark, home_branch,
      preferred_outlet_id, spending_tier_id, customer_source_id,
      notes, is_active,
    } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_customer WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }

    if (!name?.trim() || !phone?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Nomor Telepon wajib diisi" });
    }

    if (customer_code?.trim()) {
      const [dupCode] = await safeMyWaschenQuery(
        "SELECT id FROM mst_customer WHERE customer_code = ? AND id != ?",
        [customer_code.trim(), id]
      );
      if (dupCode.length) {
        return res.status(400).json({ success: false, message: `Kode pelanggan "${customer_code.trim()}" sudah digunakan` });
      }
    }

    const [dupPhone] = await safeMyWaschenQuery(
      "SELECT id FROM mst_customer WHERE phone = ? AND id != ?",
      [phone.trim(), id]
    );
    if (dupPhone.length) {
      return res.status(400).json({ success: false, message: "Nomor telepon sudah digunakan pelanggan lain" });
    }

    await safeMyWaschenQuery(
      `UPDATE mst_customer SET
        customer_code = COALESCE(?, customer_code),
        name = ?,
        phone = ?,
        email = ?,
        address = ?,
        city = ?,
        postal_code = ?,
        landmark = ?,
        home_branch = ?,
        preferred_outlet_id = ?,
        spending_tier_id = ?,
        customer_source_id = ?,
        notes = ?,
        is_active = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        customer_code?.trim() || null,
        name.trim(),
        phone.trim(),
        email?.trim() || null,
        address?.trim() || null,
        city?.trim() || null,
        postal_code?.trim() || null,
        landmark?.trim() || null,
        home_branch?.trim() || null,
        normalizeOptionalId(preferred_outlet_id),
        normalizeOptionalId(spending_tier_id),
        normalizeOptionalId(customer_source_id),
        notes?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Pelanggan berhasil diperbarui" });
  } catch (err) {
    console.error("updateCustomer error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id, name FROM mst_customer WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Pelanggan tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery("SELECT id FROM tr_transaction WHERE customer_id = ? LIMIT 1", [id]);
    if (used.length) {
      return res.status(400).json({
        success: false,
        message: "Pelanggan tidak dapat dihapus karena sudah memiliki riwayat transaksi",
      });
    }

    await safeMyWaschenQuery("DELETE FROM mst_customer WHERE id = ?", [id]);
    res.json({ success: true, message: "Pelanggan berhasil dihapus" });
  } catch (err) {
    console.error("deleteCustomer error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
