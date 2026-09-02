import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";
import { buildProduksiPhotoUrl } from "../HRIS/hrisAssetHelpers.js";

function resolvePaymentStatus(paidAmount, grandTotal) {
  const paid = Number(paidAmount) || 0;
  const total = Number(grandTotal) || 0;
  if (paid <= 0) return "Outstanding";
  if (paid + 0.009 < total) return "DP";
  return "Lunas";
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Validasi employee Waschen (company 5 + ada di mst_role). */
async function assertWaschenEmployee(employeeId) {
  const id = Number(employeeId);
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("employee_id wajib diisi (dari mst_employee)");
    err.status = 400;
    throw err;
  }

  const [empRows] = await safeQuery(
    `SELECT e.employee_id, e.full_name, e.employee_code
     FROM mst_employee e
     WHERE e.employee_id = ? AND e.company_id = 5 AND e.is_deleted = 0 AND e.exit_date IS NULL
     LIMIT 1`,
    [id]
  );
  if (!empRows.length) {
    const err = new Error("Karyawan tidak ditemukan di mst_employee Waschen");
    err.status = 404;
    throw err;
  }

  const [roleRows] = await safeMyWaschenQuery(
    "SELECT employee_id, role, outlet_id FROM mst_role WHERE employee_id = ? LIMIT 1",
    [id]
  );
  if (!roleRows.length) {
    const err = new Error("Karyawan belum terdaftar di role My Waschen");
    err.status = 403;
    throw err;
  }

  return { ...empRows[0], role: roleRows[0].role, outlet_id: roleRows[0].outlet_id };
}

function mapTransactionRow(row) {
  return {
    id: row.id,
    orderNo: row.order_no,
    barcode: row.barcode || row.order_no,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerCode: row.customer_code,
    customerAddress: row.customer_address || null,
    depositBalance: num(row.deposit_balance),
    outletId: row.outlet_id,
    outletCode: row.outlet_code,
    outletName: row.outlet_name,
    branch: row.outlet_full_name || row.outlet_name,
    cashierEmployeeId: row.cashier_employee_id,
    cashierName: row.cashier_name,
    orderCategory: row.order_category,
    grandTotal: num(row.grand_total),
    paidAmount: num(row.paid_amount),
    changeAmount: num(row.change_amount),
    discountAmount: num(row.discount_amount),
    paymentStatus: row.payment_status || "Outstanding",
    paymentMethod: row.payment_method,
    paymentProofUrl: row.payment_proof_url,
    paidAt: row.paid_at,
    workStatus: num(row.work_status, 10),
    isDelivery: Boolean(row.is_delivery),
    orderDate: row.order_date,
    createdAt: row.created_at || row.order_date,
    estimatedFinishedAt: row.estimated_finished_at || null,
    actualFinishedAt: row.actual_finished_at || null,
    totalWeightKg: num(row.total_weight_kg),
    totalPcs: num(row.total_pcs),
    outletAddress: row.outlet_address || null,
    speedName: row.speed_name,
    parfumeName: row.parfume_name,
    specialNotes: row.special_notes,
    isDeleteRequested: Boolean(row.is_delete_requested),
    deleteApprovalStatus: row.delete_approval_status,
    deleteRequestedAt: row.delete_requested_at,
    deleteReason: row.delete_reason,
    isRefundRequested: Boolean(row.is_refund_requested),
    refundApprovalStatus: row.refund_approval_status,
    refundRequestedAt: row.refund_requested_at,
    refundReason: row.refund_reason,
    refundAmount: num(row.refund_amount),
    itemCount: num(row.item_count),
  };
}

const PROGRESS_STAGE_LABELS = {
  frontliner: "Frontliner",
  washing: "Pencucian",
  ironing: "Penyetrikaan",
  packing: "Pengemasan",
  delivery: "Pengiriman",
};

async function fetchEmployeeNameMap(ids) {
  const unique = [...new Set((ids || []).map(Number).filter((id) => id > 0))];
  if (!unique.length) return {};
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${unique.map(() => "?").join(",")})`,
    unique
  );
  return Object.fromEntries(rows.map((r) => [r.employee_id, r.full_name]));
}

const TXN_SELECT = `
  SELECT t.*,
         c.name AS customer_name, c.phone AS customer_phone, c.customer_code,
         c.address AS customer_address,
         COALESCE(c.deposit_balance, 0) AS deposit_balance,
         o.outlet_code, o.name AS outlet_name, o.full_name AS outlet_full_name,
         o.address AS outlet_address,
         ss.name AS speed_name,
         pf.name AS parfume_name,
         (SELECT COUNT(*) FROM tr_transaction_detail td WHERE td.transaction_id = t.id) AS item_count
  FROM tr_transaction t
  LEFT JOIN mst_customer c ON c.id = t.customer_id
  LEFT JOIN mst_outlet o ON o.id = t.outlet_id
  LEFT JOIN mst_service_speed ss ON ss.id = t.speed_id
  LEFT JOIN mst_parfume pf ON pf.id = t.parfume_id
`;

/** GET /waschen/transactions */
export const getTransactions = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const paymentStatus = String(req.query.paymentStatus || "").trim();
    const dateFrom = String(req.query.dateFrom || "").trim();
    const dateTo = String(req.query.dateTo || "").trim();
    const date = String(req.query.date || "").trim();
    const workMin = req.query.workMin !== undefined && req.query.workMin !== "" ? Number(req.query.workMin) : null;
    const workMax = req.query.workMax !== undefined && req.query.workMax !== "" ? Number(req.query.workMax) : null;
    const includeDeleted = String(req.query.includeDeleted || "") === "1";
    const listType = String(req.query.listType || "active").trim(); // active | delete | refund

    const where = [];
    const params = [];

    if (listType === "delete") {
      where.push("t.is_delete_requested = 1");
    } else if (listType === "refund") {
      where.push("t.is_refund_requested = 1");
    } else if (!includeDeleted) {
      where.push("t.is_delete_requested = 0");
    }

    if (search) {
      where.push(
        `(t.order_no LIKE ? OR t.barcode LIKE ? OR c.name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ?)`
      );
      const like = `%${search}%`;
      params.push(like, like, like, like, like);
    }
    if (outletId) {
      where.push("t.outlet_id = ?");
      params.push(outletId);
    }
    if (paymentStatus && paymentStatus !== "Semua") {
      if (paymentStatus === "Sisa Tagihan") {
        where.push("t.payment_status IN ('DP', 'Outstanding')");
      } else {
        where.push("t.payment_status = ?");
        params.push(paymentStatus);
      }
    }
    if (date) {
      where.push("DATE(t.order_date) = ?");
      params.push(date);
    } else {
      if (dateFrom) {
        where.push("t.order_date >= ?");
        params.push(`${dateFrom} 00:00:00`);
      }
      if (dateTo) {
        where.push("t.order_date <= ?");
        params.push(`${dateTo} 23:59:59`);
      }
    }
    if (Number.isFinite(workMin)) {
      where.push("t.work_status >= ?");
      params.push(workMin);
    }
    if (Number.isFinite(workMax)) {
      where.push("t.work_status <= ?");
      params.push(workMax);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await safeMyWaschenQuery(
      `${TXN_SELECT} ${whereSql} ORDER BY t.order_date DESC, t.id DESC LIMIT 500`,
      params
    );

    // cashier names from main DB (best-effort)
    const cashierIds = [...new Set(rows.map((r) => r.cashier_employee_id).filter(Boolean))];
    let cashierMap = {};
    if (cashierIds.length) {
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${cashierIds.map(() => "?").join(",")})`,
        cashierIds
      );
      cashierMap = Object.fromEntries(emps.map((e) => [e.employee_id, e.full_name]));
    }

    const data = rows.map((r) =>
      mapTransactionRow({ ...r, cashier_name: cashierMap[r.cashier_employee_id] || null })
    );

    res.json({ success: true, data, meta: { count: data.length } });
  } catch (err) {
    console.error("getTransactions error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/transactions/:id */
export const getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery(
      `${TXN_SELECT} WHERE t.id = ? OR t.order_no = ? LIMIT 1`,
      [id, id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }
    const row = rows[0];

    const [[details], [logs], [statusLogs], [progressRows]] = await Promise.all([
      safeMyWaschenQuery(
        `SELECT td.*, s.code AS service_code,
                COALESCE(ml.name, CASE WHEN td.laundry_method_id = 2 THEN 'Dry Clean' ELSE 'Wet Clean' END) AS laundry_method_name,
                COALESCE(ml.code, CASE WHEN td.laundry_method_id = 2 THEN 'DC' ELSE 'WC' END) AS laundry_method_code
         FROM tr_transaction_detail td
         LEFT JOIN mst_service s ON s.id = td.service_id
         LEFT JOIN mst_method_laundry ml ON ml.id = td.laundry_method_id
         WHERE td.transaction_id = ?
         ORDER BY td.id ASC`,
        [row.id]
      ),
      safeMyWaschenQuery(
        `SELECT * FROM tr_payment_log WHERE transaction_id = ? ORDER BY id ASC`,
        [row.id]
      ),
      safeMyWaschenQuery(
        `SELECT * FROM tr_transaction_status_log WHERE transaction_id = ? ORDER BY created_at ASC, id ASC LIMIT 100`,
        [row.id]
      ),
      safeMyWaschenQuery(
        `SELECT * FROM tr_item_progress WHERE transaction_id = ? ORDER BY completed_at ASC, id ASC`,
        [row.id]
      ),
    ]);

    const empMap = await fetchEmployeeNameMap([
      ...statusLogs.map((l) => l.employee_id),
      ...progressRows.map((p) => p.employee_id),
      ...progressRows.map((p) => p.hold_resolved_by),
    ]);

    const progressIds = progressRows.map((p) => p.id);
    const photoMap = {};
    if (progressIds.length) {
      const [photoRows] = await safeMyWaschenQuery(
        `SELECT id, progress_id, photo_path, photo_type
         FROM tr_item_progress_photo
         WHERE progress_id IN (${progressIds.map(() => "?").join(",")})
         ORDER BY id ASC`,
        progressIds,
      );
      for (const ph of photoRows) {
        if (!photoMap[ph.progress_id]) photoMap[ph.progress_id] = [];
        photoMap[ph.progress_id].push({
          id: ph.id,
          photo_type: ph.photo_type,
          photo_path: ph.photo_path,
          photo_url: buildProduksiPhotoUrl(req, ph.photo_path),
        });
      }
    }

    const progressByDetail = {};
    for (const p of progressRows) {
      const detailId = p.transaction_detail_id;
      if (!progressByDetail[detailId]) progressByDetail[detailId] = [];
      progressByDetail[detailId].push({
        id: p.id,
        stage: p.stage,
        stage_label: PROGRESS_STAGE_LABELS[p.stage] || p.stage,
        employee_id: p.employee_id,
        employee_name: p.employee_name || empMap[p.employee_id] || null,
        role_used: p.role_used,
        qc_status: p.qc_status,
        qc_decision: p.qc_decision,
        notes: p.notes,
        status: p.status,
        completed_at: p.completed_at,
        hold_resolved_by_name: p.hold_resolved_by ? empMap[p.hold_resolved_by] || null : null,
        hold_resolution_note: p.hold_resolution_note,
        photos: photoMap[p.id] || [],
      });
    }

    const enrichedLogs = statusLogs.map((l) => ({
      ...l,
      employee_name: empMap[l.employee_id] || null,
    }));

    const items = details.map((d) => ({
      ...d,
      workers: progressByDetail[d.id] || [],
    }));

    let cashierName = null;
    if (row.cashier_employee_id) {
      const [emps] = await safeQuery(
        "SELECT full_name FROM mst_employee WHERE employee_id = ? LIMIT 1",
        [row.cashier_employee_id]
      );
      cashierName = emps[0]?.full_name || null;
    }

    const order = mapTransactionRow({ ...row, cashier_name: cashierName });
    res.json({
      success: true,
      data: {
        order,
        items,
        paymentLogs: logs,
        statusLogs: enrichedLogs,
        remaining: Math.max(0, order.grandTotal - order.paidAmount),
      },
    });
  } catch (err) {
    console.error("getTransactionById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/transactions/:id/payment — update / pelunasan */
export const updateTransactionPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      paymentMethod,
      additionalAmount,
      paidAmount,
      overpaymentAction,
      notes,
      cashierEmployeeId,
      paymentProofUrl,
    } = req.body || {};

    const [orderRows] = await safeMyWaschenQuery(
      "SELECT * FROM tr_transaction WHERE id = ? OR order_no = ? LIMIT 1",
      [id, id]
    );
    if (!orderRows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }

    const order = orderRows[0];
    const grandTotal = num(order.grand_total);
    const currentPaid = num(order.paid_amount);
    let newPaid = currentPaid;
    let changeAmount = num(order.change_amount);
    let refundAmountToSave = 0;
    let targetStatus = order.payment_status;

    if (additionalAmount !== undefined && additionalAmount !== null) {
      const add = num(additionalAmount);
      if (add <= 0) {
        return res.status(400).json({ success: false, message: "Nominal tambahan bayar harus lebih dari 0" });
      }
      const totalPaidAttempt = currentPaid + add;
      targetStatus = resolvePaymentStatus(totalPaidAttempt, grandTotal);

      if (targetStatus === "Lunas" && totalPaidAttempt > grandTotal) {
        const excess = Math.round((totalPaidAttempt - grandTotal) * 100) / 100;
        if (String(overpaymentAction || "").toLowerCase() === "refund") {
          newPaid = totalPaidAttempt;
          changeAmount = 0;
          refundAmountToSave = excess;
        } else {
          newPaid = grandTotal;
          changeAmount = excess;
        }
      } else {
        newPaid = Math.min(totalPaidAttempt, grandTotal);
        changeAmount = 0;
      }

      await safeMyWaschenQuery(
        `INSERT INTO tr_payment_log
          (transaction_id, log_type, amount, payment_method, payment_proof_url, notes, cashier_employee_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          currentPaid <= 0 ? (targetStatus === "Lunas" ? "Lunas" : "DP") : "Pelunasan",
          add,
          paymentMethod || order.payment_method || "Tunai",
          paymentProofUrl || null,
          notes || `Pelunasan nota ${order.order_no}`,
          cashierEmployeeId || order.cashier_employee_id || null,
        ]
      );
    } else if (paidAmount !== undefined) {
      newPaid = num(paidAmount);
      targetStatus = resolvePaymentStatus(newPaid, grandTotal);
      if (targetStatus === "Lunas" && newPaid > grandTotal) {
        const excess = Math.round((newPaid - grandTotal) * 100) / 100;
        if (String(overpaymentAction || "").toLowerCase() === "refund") {
          refundAmountToSave = excess;
          changeAmount = 0;
        } else {
          changeAmount = excess;
          newPaid = grandTotal;
        }
      }
    }

    const method = targetStatus === "Outstanding" ? "-" : paymentMethod || order.payment_method || "Tunai";

    await safeMyWaschenQuery(
      `UPDATE tr_transaction SET
         payment_status = ?,
         payment_method = ?,
         paid_amount = ?,
         change_amount = ?,
         payment_proof_url = COALESCE(?, payment_proof_url),
         paid_at = CASE
           WHEN ? <> 'Outstanding' AND (paid_at IS NULL OR ? = 'Lunas') THEN NOW()
           ELSE paid_at
         END,
         is_refund_requested = CASE WHEN ? > 0 THEN 1 ELSE is_refund_requested END,
         refund_approval_status = CASE WHEN ? > 0 THEN 0 ELSE refund_approval_status END,
         refund_requested_at = CASE WHEN ? > 0 THEN NOW() ELSE refund_requested_at END,
         refund_reason = CASE WHEN ? > 0 THEN ? ELSE refund_reason END,
         refund_amount = CASE WHEN ? > 0 THEN ? ELSE refund_amount END,
         updated_at = NOW()
       WHERE id = ?`,
      [
        targetStatus,
        method,
        newPaid,
        changeAmount,
        paymentProofUrl || null,
        targetStatus,
        targetStatus,
        refundAmountToSave,
        refundAmountToSave,
        refundAmountToSave,
        refundAmountToSave,
        refundAmountToSave > 0
          ? `Kelebihan bayar nota ${order.order_no} — gap refund Rp ${refundAmountToSave.toLocaleString("id-ID")}`
          : null,
        refundAmountToSave,
        refundAmountToSave,
        order.id,
      ]
    );

    res.json({
      success: true,
      message: `Pembayaran nota ${order.order_no} diperbarui (${targetStatus})`,
      data: {
        transactionId: order.id,
        orderNo: order.order_no,
        paymentStatus: targetStatus,
        paymentMethod: method,
        paidAmount: newPaid,
        changeAmount,
        remaining: Math.max(0, grandTotal - newPaid),
        refundRequested: refundAmountToSave > 0,
        refundAmount: refundAmountToSave,
      },
    });
  } catch (err) {
    console.error("updateTransactionPayment error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/transactions/:id/request-delete */
export const requestDeleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: "Alasan pengajuan hapus wajib diisi" });
    }

    const [rows] = await safeMyWaschenQuery(
      "SELECT id, order_no, is_delete_requested FROM tr_transaction WHERE id = ? OR order_no = ? LIMIT 1",
      [id, id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }
    if (rows[0].is_delete_requested) {
      return res.status(400).json({ success: false, message: "Nota sudah dalam pengajuan hapus" });
    }

    await safeMyWaschenQuery(
      `UPDATE tr_transaction SET
         is_delete_requested = 1,
         delete_approval_status = 0,
         delete_requested_at = NOW(),
         delete_reason = ?,
         updated_at = NOW()
       WHERE id = ?`,
      [reason, rows[0].id]
    );

    res.json({
      success: true,
      message: `Pengajuan hapus nota ${rows[0].order_no} berhasil dikirim`,
      data: { transactionId: rows[0].id, orderNo: rows[0].order_no },
    });
  } catch (err) {
    console.error("requestDeleteTransaction error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/transactions/:id/approve-delete — approve by mst_employee */
export const approveDeleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await assertWaschenEmployee(req.body?.employeeId);

    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM tr_transaction WHERE id = ? OR order_no = ? LIMIT 1",
      [id, id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }
    const order = rows[0];
    if (!order.is_delete_requested) {
      return res.status(400).json({ success: false, message: "Nota tidak dalam pengajuan hapus" });
    }
    if (Number(order.delete_approval_status) === 1) {
      return res.status(400).json({ success: false, message: "Pengajuan hapus sudah disetujui" });
    }

    const note = `[APPROVED by ${employee.employee_code} — ${employee.full_name} @ ${new Date().toISOString()}]`;
    await safeMyWaschenQuery(
      `UPDATE tr_transaction SET
         delete_approval_status = 1,
         delete_reason = CONCAT(COALESCE(delete_reason, ''), '\n', ?),
         updated_at = NOW()
       WHERE id = ?`,
      [note, order.id]
    );

    await safeMyWaschenQuery(
      `INSERT INTO tr_transaction_status_log (transaction_id, status, employee_id, notes)
       VALUES (?, 'Dibatalkan', ?, ?)`,
      [order.id, employee.employee_id, `Approve hapus nota oleh ${employee.full_name}`]
    );

    res.json({
      success: true,
      message: `Pengajuan hapus nota ${order.order_no} disetujui`,
      data: {
        transactionId: order.id,
        orderNo: order.order_no,
        approvedBy: {
          employeeId: employee.employee_id,
          employeeCode: employee.employee_code,
          fullName: employee.full_name,
        },
      },
    });
  } catch (err) {
    console.error("approveDeleteTransaction error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/transactions/:id/approve-refund */
export const approveRefundTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await assertWaschenEmployee(req.body?.employeeId);

    const [rows] = await safeMyWaschenQuery(
      "SELECT * FROM tr_transaction WHERE id = ? OR order_no = ? LIMIT 1",
      [id, id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }
    const order = rows[0];
    if (!order.is_refund_requested) {
      return res.status(400).json({ success: false, message: "Nota tidak dalam pengajuan refund" });
    }
    if (Number(order.refund_approval_status) === 1) {
      return res.status(400).json({ success: false, message: "Pengajuan refund sudah disetujui" });
    }

    const note = `[APPROVED by ${employee.employee_code} — ${employee.full_name} @ ${new Date().toISOString()}]`;
    await safeMyWaschenQuery(
      `UPDATE tr_transaction SET
         refund_approval_status = 1,
         refund_reason = CONCAT(COALESCE(refund_reason, ''), '\n', ?),
         updated_at = NOW()
       WHERE id = ?`,
      [note, order.id]
    );

    await safeMyWaschenQuery(
      `INSERT INTO tr_transaction_status_log (transaction_id, status, employee_id, notes)
       VALUES (?, ?, ?, ?)`,
      [
        order.id,
        order.payment_status === "Lunas" ? "Selesai" : "Antrean",
        employee.employee_id,
        `Approve refund Rp ${num(order.refund_amount).toLocaleString("id-ID")} oleh ${employee.full_name}`,
      ]
    );

    res.json({
      success: true,
      message: `Pengajuan refund nota ${order.order_no} disetujui`,
      data: {
        transactionId: order.id,
        orderNo: order.order_no,
        refundAmount: num(order.refund_amount),
        approvedBy: {
          employeeId: employee.employee_id,
          employeeCode: employee.employee_code,
          fullName: employee.full_name,
        },
      },
    });
  } catch (err) {
    console.error("approveRefundTransaction error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/** PATCH /waschen/transactions/:id/items/:itemId/status — update status item */
export const updateItemWorkStatus = async (req, res) => {
  try {
    const { id, itemId } = req.params;
    const status = String(req.body?.status || "").trim();
    const employeeId = req.body?.employeeId ? Number(req.body.employeeId) : null;
    const notes = String(req.body?.notes || "").trim() || null;

    const allowed = [
      "Antrean",
      "Pencucian",
      "Penyetrikaan",
      "Pengemasan",
      "Siap Diambil",
      "Siap Diantar",
      "Selesai",
      "Dibatalkan",
    ];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: "Status item tidak valid" });
    }

    const [txRows] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction WHERE id = ? OR order_no = ? LIMIT 1",
      [id, id]
    );
    if (!txRows.length) {
      return res.status(404).json({ success: false, message: "Nota tidak ditemukan" });
    }
    const txnId = txRows[0].id;

    const [itemRows] = await safeMyWaschenQuery(
      "SELECT id FROM tr_transaction_detail WHERE id = ? AND transaction_id = ? LIMIT 1",
      [itemId, txnId]
    );
    if (!itemRows.length) {
      return res.status(404).json({ success: false, message: "Item tidak ditemukan" });
    }

    try {
      await safeMyWaschenQuery(
        `UPDATE tr_transaction_detail SET
           item_work_status = ?,
           item_completed_at = CASE WHEN ? IN ('Selesai', 'Siap Diambil', 'Siap Diantar') THEN NOW() ELSE NULL END
         WHERE id = ?`,
        [status, status, itemId]
      );
    } catch (colErr) {
      if (colErr?.code === "ER_BAD_FIELD_ERROR" && String(colErr?.sqlMessage || "").includes("item_completed_at")) {
        await safeMyWaschenQuery(
          `UPDATE tr_transaction_detail SET item_work_status = ? WHERE id = ?`,
          [status, itemId]
        );
      } else {
        throw colErr;
      }
    }

    await safeMyWaschenQuery(
      `INSERT INTO tr_transaction_status_log (transaction_id, transaction_detail_id, status, employee_id, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [txnId, itemId, status, employeeId, notes]
    );

    // recalculate average work_status from mst_work_status percentages
    const [avgRows] = await safeMyWaschenQuery(
      `SELECT AVG(COALESCE(ws.percentage, 10)) AS avg_pct
       FROM tr_transaction_detail td
       LEFT JOIN mst_work_status ws ON ws.name = td.item_work_status OR ws.label = td.item_work_status
       WHERE td.transaction_id = ?`,
      [txnId]
    );
    const avgPct = Math.round(num(avgRows[0]?.avg_pct, 10) * 100) / 100;
    await safeMyWaschenQuery("UPDATE tr_transaction SET work_status = ?, updated_at = NOW() WHERE id = ?", [
      avgPct,
      txnId,
    ]);

    res.json({
      success: true,
      message: "Status item diperbarui",
      data: { transactionId: txnId, itemId: Number(itemId), status, workStatus: avgPct },
    });
  } catch (err) {
    console.error("updateItemWorkStatus error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/transactions/meta/summary — counts for tabs */
export const getTransactionSummary = async (_req, res) => {
  try {
    const [[active], [delPending], [delApproved], [refPending], [refApproved]] = await Promise.all([
      safeMyWaschenQuery("SELECT COUNT(*) AS c FROM tr_transaction WHERE is_delete_requested = 0"),
      safeMyWaschenQuery(
        "SELECT COUNT(*) AS c FROM tr_transaction WHERE is_delete_requested = 1 AND (delete_approval_status = 0 OR delete_approval_status IS NULL)"
      ),
      safeMyWaschenQuery(
        "SELECT COUNT(*) AS c FROM tr_transaction WHERE is_delete_requested = 1 AND delete_approval_status = 1"
      ),
      safeMyWaschenQuery(
        "SELECT COUNT(*) AS c FROM tr_transaction WHERE is_refund_requested = 1 AND (refund_approval_status = 0 OR refund_approval_status IS NULL)"
      ),
      safeMyWaschenQuery(
        "SELECT COUNT(*) AS c FROM tr_transaction WHERE is_refund_requested = 1 AND refund_approval_status = 1"
      ),
    ]);

    res.json({
      success: true,
      data: {
        activeCount: num(active[0]?.c),
        deletePending: num(delPending[0]?.c),
        deleteApproved: num(delApproved[0]?.c),
        deleteTotal: num(delPending[0]?.c) + num(delApproved[0]?.c),
        refundPending: num(refPending[0]?.c),
        refundApproved: num(refApproved[0]?.c),
        refundTotal: num(refPending[0]?.c) + num(refApproved[0]?.c),
      },
    });
  } catch (err) {
    console.error("getTransactionSummary error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
