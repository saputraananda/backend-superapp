import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function assertEmployee(employeeId) {
  const id = Number(employeeId);
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("employeeId wajib diisi");
    err.status = 400;
    throw err;
  }
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name, employee_code
     FROM mst_employee
     WHERE employee_id = ? AND is_deleted = 0 AND exit_date IS NULL
     LIMIT 1`,
    [id]
  );
  if (!rows.length) {
    const err = new Error("Karyawan tidak ditemukan");
    err.status = 404;
    throw err;
  }
  return rows[0];
}

function mapPettyCashRow(row, empMap = {}) {
  return {
    id: row.id,
    outletId: row.outlet_id,
    outletCode: row.outlet_code,
    outletName: row.outlet_name,
    outletFullName: row.outlet_full_name,
    shiftId: row.shift_id,
    cashierEmployeeId: row.cashier_employee_id,
    cashierName: row.cashier_employee_id ? empMap[row.cashier_employee_id] || null : null,
    type: row.type,
    category: row.category,
    amount: num(row.amount),
    balanceBefore: num(row.balance_before),
    balanceAfter: num(row.balance_after),
    description: row.description,
    receiptPhotoUrl: row.receipt_photo_url,
    status: row.status || "Pengajuan",
    approvedByEmployeeId: row.approved_by_employee_id,
    approvedByName: row.approved_by_employee_id ? empMap[row.approved_by_employee_id] || null : null,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    transactionDate: row.transaction_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PETTY_SELECT = `
  SELECT p.*,
         o.outlet_code, o.name AS outlet_name, o.full_name AS outlet_full_name
  FROM tr_petty_cash p
  LEFT JOIN mst_outlet o ON o.id = p.outlet_id
`;

async function attachEmployeeNames(rows) {
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.cashier_employee_id, r.approved_by_employee_id].filter(Boolean))
    ),
  ];
  let empMap = {};
  if (ids.length) {
    const [emps] = await safeQuery(
      `SELECT employee_id, full_name FROM mst_employee
       WHERE employee_id IN (${ids.map(() => "?").join(",")})`,
      ids
    );
    empMap = Object.fromEntries(emps.map((e) => [e.employee_id, e.full_name]));
  }
  return rows.map((r) => mapPettyCashRow(r, empMap));
}

/** GET /waschen/petty-cash/summary */
export const getPettyCashSummary = async (req, res) => {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const where = [];
    const params = [];
    if (outletId) {
      where.push("outlet_id = ?");
      params.push(outletId);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'Pengajuan' THEN 1 ELSE 0 END) AS pending_count,
         SUM(CASE WHEN status = 'Disetujui' THEN 1 ELSE 0 END) AS approved_count,
         SUM(CASE WHEN status = 'Ditolak' THEN 1 ELSE 0 END) AS rejected_count,
         COALESCE(SUM(CASE WHEN status = 'Pengajuan' THEN amount ELSE 0 END), 0) AS pending_amount
       FROM tr_petty_cash ${whereSql}`,
      params
    );

    res.json({
      success: true,
      data: {
        total: num(rows[0]?.total),
        pendingCount: num(rows[0]?.pending_count),
        approvedCount: num(rows[0]?.approved_count),
        rejectedCount: num(rows[0]?.rejected_count),
        pendingAmount: num(rows[0]?.pending_amount),
      },
    });
  } catch (err) {
    console.error("getPettyCashSummary error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/petty-cash */
export const getPettyCashList = async (req, res) => {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const status = String(req.query.status || "").trim();
    const type = String(req.query.type || "").trim();
    const search = String(req.query.search || "").trim();
    const dateFrom = String(req.query.dateFrom || "").slice(0, 10);
    const dateTo = String(req.query.dateTo || "").slice(0, 10);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));

    const where = [];
    const params = [];

    if (outletId) {
      where.push("p.outlet_id = ?");
      params.push(outletId);
    }
    if (status && ["Pengajuan", "Disetujui", "Ditolak"].includes(status)) {
      where.push("p.status = ?");
      params.push(status);
    }
    if (type && ["Masuk", "Keluar"].includes(type)) {
      where.push("p.type = ?");
      params.push(type);
    }
    if (dateFrom) {
      where.push("DATE(p.transaction_date) >= ?");
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push("DATE(p.transaction_date) <= ?");
      params.push(dateTo);
    }
    if (search) {
      where.push("(p.category LIKE ? OR p.description LIKE ? OR o.name LIKE ? OR o.outlet_code LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `${PETTY_SELECT} ${whereSql}
       ORDER BY p.transaction_date DESC, p.id DESC
       LIMIT ${limit}`,
      params
    );

    const data = await attachEmployeeNames(rows);
    res.json({ success: true, data });
  } catch (err) {
    console.error("getPettyCashList error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/petty-cash/:id */
export const getPettyCashById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery(`${PETTY_SELECT} WHERE p.id = ? LIMIT 1`, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pengajuan petty cash tidak ditemukan" });
    }
    const [data] = await attachEmployeeNames(rows);
    res.json({ success: true, data });
  } catch (err) {
    console.error("getPettyCashById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PUT /waschen/petty-cash/:id — admin koreksi isi pengajuan (hanya status Pengajuan) */
export const updatePettyCash = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_petty_cash WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pengajuan petty cash tidak ditemukan" });
    }
    const row = rows[0];
    if (row.status !== "Pengajuan") {
      return res.status(400).json({
        success: false,
        message: `Status sudah ${row.status} — hanya pengajuan yang masih menunggu yang bisa diedit`,
      });
    }

    const type = String(req.body?.type || row.type).trim();
    const category = String(req.body?.category || row.category).trim();
    const amount = num(req.body?.amount, NaN);
    const description =
      req.body?.description !== undefined
        ? String(req.body.description || "").trim() || null
        : row.description;
    const outletId = req.body?.outletId !== undefined ? Number(req.body.outletId) : Number(row.outlet_id);

    if (!["Masuk", "Keluar"].includes(type)) {
      return res.status(400).json({ success: false, message: "type harus Masuk atau Keluar" });
    }
    if (!category) {
      return res.status(400).json({ success: false, message: "Kategori wajib diisi" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: "Nominal wajib angka > 0" });
    }
    if (!outletId) {
      return res.status(400).json({ success: false, message: "outletId wajib" });
    }

    const [outlet] = await safeMyWaschenQuery("SELECT id FROM mst_outlet WHERE id = ? LIMIT 1", [outletId]);
    if (!outlet.length) {
      return res.status(404).json({ success: false, message: "Outlet tidak ditemukan" });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_petty_cash
       SET outlet_id = ?,
           type = ?,
           category = ?,
           amount = ?,
           description = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [outletId, type, category, amount, description, id]
    );

    res.json({ success: true, message: "Pengajuan petty cash diperbarui" });
  } catch (err) {
    console.error("updatePettyCash error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/petty-cash/:id/approve */
export const approvePettyCash = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = Number(req.body?.employeeId);

    await assertEmployee(employeeId);

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_petty_cash WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pengajuan petty cash tidak ditemukan" });
    }
    const row = rows[0];
    if (row.status !== "Pengajuan") {
      return res.status(400).json({ success: false, message: `Status sudah ${row.status}, tidak bisa disetujui` });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_petty_cash
       SET status = 'Disetujui',
           approved_by_employee_id = ?,
           approved_at = NOW(),
           rejected_reason = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [employeeId, id]
    );

    res.json({ success: true, message: "Pengajuan petty cash disetujui" });
  } catch (err) {
    console.error("approvePettyCash error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/petty-cash/:id/reject */
export const rejectPettyCash = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = Number(req.body?.employeeId);
    const rejectedReason = String(req.body?.rejectedReason || req.body?.notes || "").trim();

    if (!rejectedReason) {
      return res.status(400).json({ success: false, message: "Catatan penolakan wajib diisi" });
    }

    await assertEmployee(employeeId);

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_petty_cash WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pengajuan petty cash tidak ditemukan" });
    }
    const row = rows[0];
    if (row.status !== "Pengajuan") {
      return res.status(400).json({ success: false, message: `Status sudah ${row.status}, tidak bisa ditolak` });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_petty_cash
       SET status = 'Ditolak',
           approved_by_employee_id = ?,
           approved_at = NOW(),
           rejected_reason = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [employeeId, rejectedReason, id]
    );

    res.json({ success: true, message: "Pengajuan petty cash ditolak" });
  } catch (err) {
    console.error("rejectPettyCash error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/** DELETE /waschen/petty-cash/:id — hapus pengajuan yang masih menunggu */
export const deletePettyCash = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_petty_cash WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Pengajuan petty cash tidak ditemukan" });
    }
    if (rows[0].status !== "Pengajuan") {
      return res.status(400).json({
        success: false,
        message: `Status sudah ${rows[0].status} — hanya pengajuan menunggu yang bisa dihapus`,
      });
    }

    await safeMyWaschenQuery("DELETE FROM tr_petty_cash WHERE id = ?", [id]);
    res.json({ success: true, message: "Pengajuan petty cash dihapus" });
  } catch (err) {
    console.error("deletePettyCash error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
