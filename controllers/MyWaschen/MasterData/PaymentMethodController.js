import { safeQuery, safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "label", "group", "created_at"];

/** Setelan Bayar Backdate: satu baris (id = 1), dibaca POS di api/utils/backdatePayment.js. */
async function ensureBackdateTable() {
  await safeMyWaschenQuery(`
    CREATE TABLE IF NOT EXISTS \`mst_payment_backdate\` (
      \`id\` tinyint unsigned NOT NULL,
      \`is_active\` tinyint(1) NOT NULL DEFAULT '0',
      \`updated_by\` varchar(100) DEFAULT NULL,
      \`updated_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Riwayat aktif/nonaktif: siapa & jam berapa
  await safeMyWaschenQuery(`
    CREATE TABLE IF NOT EXISTS \`mst_payment_backdate_log\` (
      \`id\` int unsigned NOT NULL AUTO_INCREMENT,
      \`is_active\` tinyint(1) NOT NULL,
      \`changed_by_id\` varchar(64) DEFAULT NULL,
      \`changed_by\` varchar(100) DEFAULT NULL,
      \`changed_at\` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_changed_at\` (\`changed_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/** Admin yang sedang login (session Super App): nama lengkap karyawan, fallback username/email. */
async function sessionActor(req) {
  const s = req.session || {};
  let name = null;
  if (s.employeeId) {
    try {
      const [rows] = await safeQuery(
        "SELECT full_name FROM mst_employee WHERE employee_id = ? LIMIT 1",
        [s.employeeId]
      );
      name = rows[0]?.full_name || null;
    } catch (err) {
      console.error("sessionActor employee lookup error:", err);
    }
  }
  return {
    by: name || s.userName || s.userEmail || null,
    byId: s.employeeId ?? s.userId ?? null,
  };
}

const backdateTableReady = ensureBackdateTable().catch((err) => {
  console.error("ensureBackdateTable mst_payment_backdate error:", err);
});

export const getPaymentSettings = async (req, res) => {
  try {
    await backdateTableReady;
    const [[rows], [logs]] = await Promise.all([
      safeMyWaschenQuery("SELECT is_active, updated_by, updated_at FROM mst_payment_backdate WHERE id = 1 LIMIT 1"),
      safeMyWaschenQuery(
        "SELECT id, is_active, changed_by, changed_at FROM mst_payment_backdate_log ORDER BY changed_at DESC, id DESC LIMIT 50"
      ),
    ]);
    res.json({
      success: true,
      data: {
        allow_backdate_payment: Number(rows[0]?.is_active) === 1 ? 1 : 0,
        updated_by: rows[0]?.updated_by || null,
        updated_at: rows[0]?.updated_at || null,
        logs,
      },
    });
  } catch (err) {
    console.error("getPaymentSettings error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePaymentSettings = async (req, res) => {
  try {
    await backdateTableReady;
    const enabled = req.body?.allow_backdate_payment ? 1 : 0;
    const { by, byId } = await sessionActor(req);

    const [cur] = await safeMyWaschenQuery("SELECT is_active FROM mst_payment_backdate WHERE id = 1 LIMIT 1");
    const changed = Number(cur[0]?.is_active ?? 0) !== enabled || !cur.length;

    await safeMyWaschenQuery(
      `INSERT INTO mst_payment_backdate (id, is_active, updated_by)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), updated_by = VALUES(updated_by), updated_at = NOW()`,
      [enabled, by]
    );
    // Catat hanya bila status benar-benar berubah (klik ganda tidak menggandakan log)
    if (changed) {
      await safeMyWaschenQuery(
        "INSERT INTO mst_payment_backdate_log (is_active, changed_by_id, changed_by) VALUES (?, ?, ?)",
        [enabled, byId != null ? String(byId) : null, by]
      );
    }
    res.json({
      success: true,
      message: enabled ? "Bayar backdate diaktifkan" : "Bayar backdate dinonaktifkan",
      data: { allow_backdate_payment: enabled },
    });
  } catch (err) {
    console.error("updatePaymentSettings error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPaymentMethods = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const isActive = req.query.isActive;
    const group = String(req.query.group || "").trim();
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "id";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
    const orderCol = sortBy === "group" ? "`group`" : sortBy;

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR label LIKE ? OR `group` LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    if (group) {
      where.push("`group` = ?");
      params.push(group);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_payment_method ${whereSql} ORDER BY ${orderCol} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getPaymentMethods error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getPaymentMethodById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_payment_method WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getPaymentMethodById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createPaymentMethod = async (req, res) => {
  try {
    const { code, name, label, group, requires_member_balance, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Kode, Nama, dan Label wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_payment_method WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_payment_method (\`group\`, code, name, label, requires_member_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        group?.trim() || "Tunai",
        formattedCode,
        name.trim(),
        label.trim(),
        requires_member_balance ? 1 : 0,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Metode pembayaran berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createPaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updatePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, label, group, requires_member_balance, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_payment_method WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }

    if (!name?.trim() || !label?.trim()) {
      return res.status(400).json({ success: false, message: "Nama dan Label wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_payment_method WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    await safeMyWaschenQuery(
      `UPDATE mst_payment_method
       SET code = COALESCE(?, code),
           name = ?,
           label = ?,
           \`group\` = ?,
           requires_member_balance = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        label.trim(),
        group?.trim() || "Tunai",
        requires_member_balance ? 1 : 0,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Metode pembayaran berhasil diperbarui" });
  } catch (err) {
    console.error("updatePaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deletePaymentMethod = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id, code FROM mst_payment_method WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Metode pembayaran tidak ditemukan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_payment_method WHERE id = ?", [id]);
    res.json({ success: true, message: "Metode pembayaran berhasil dihapus" });
  } catch (err) {
    console.error("deletePaymentMethod error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
