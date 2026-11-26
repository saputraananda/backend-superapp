import { safeMyWaschenQuery, safeQuery, myWaschenPool } from "../../../db/pool.js";
import { posFileUrl } from "../utils/waschenPosUpload.js";

/**
 * Request Hapus Pelunasan (tr_payment_void_request) — diajukan kasir POS, diputuskan di SuperApp.
 * Approve:
 *   - tr_payment_log baris itu → log_type 'Dibatalkan' (tetap ada untuk audit) sehingga keluar dari
 *     semua laporan revenue pada TANGGAL BAYAR ASLINYA. Nota lama tanpa log: dicatat satu baris
 *     'Dibatalkan' sebagai jejak (created_at = paid_at asli).
 *   - tr_transaction.paid_amount dikurangi, payment_status dihitung ulang (Lunas → DP / Outstanding);
 *     paid_at & settled_* dikosongkan bila tidak lagi Lunas.
 *   - Pembayaran Potong Saldo Member: saldo dikembalikan (tr_customer_deposit type 'Refund').
 * Reject: hanya status + catatan; pembayaran tetap.
 */

const num = (v) => Number(v) || 0;
const isMemberBalance = (method) => /saldo/i.test(String(method || ""));
const REVENUE_TYPES = "('DP','Lunas','Pelunasan')";

function resolvePaymentStatus(paid, total) {
  if (paid <= 0) return "Outstanding";
  if (paid + 0.009 < total) return "DP";
  return "Lunas";
}

async function sessionEmployee(req) {
  const id = Number(req.session?.employeeId);
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error("Akun login tidak terhubung ke data karyawan");
    err.status = 401;
    throw err;
  }
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name, employee_code FROM mst_employee
     WHERE employee_id = ? AND is_deleted = 0 AND exit_date IS NULL LIMIT 1`,
    [id]
  );
  if (!rows.length) {
    const err = new Error("Karyawan login tidak aktif");
    err.status = 403;
    throw err;
  }
  return rows[0];
}

async function employeeNames(ids) {
  const unique = [...new Set(ids.map(Number).filter((n) => n > 0))];
  if (!unique.length) return {};
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${unique.map(() => "?").join(",")})`,
    unique
  );
  return Object.fromEntries(rows.map((r) => [r.employee_id, r.full_name]));
}

/** GET /waschen/transactions/payment-voids?status=&outletId=&dateFrom=&dateTo= (tanggal = waktu pengajuan) */
export const getPaymentVoids = async (req, res) => {
  try {
    const where = [];
    const params = [];
    const status = String(req.query.status || "").trim();
    if (["Pending", "Approved", "Rejected"].includes(status)) {
      where.push("v.status = ?");
      params.push(status);
    }
    const outletId = Number(req.query.outletId) || null;
    if (outletId) {
      where.push("t.outlet_id = ?");
      params.push(outletId);
    }
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (ymd.test(String(req.query.dateFrom || ""))) {
      where.push("v.requested_at >= ?");
      params.push(`${req.query.dateFrom} 00:00:00`);
    }
    if (ymd.test(String(req.query.dateTo || ""))) {
      where.push("v.requested_at <= ?");
      params.push(`${req.query.dateTo} 23:59:59`);
    }
    const [rows] = await safeMyWaschenQuery(
      `SELECT v.*, t.order_no, t.order_date, t.grand_total, t.paid_amount, t.payment_status, t.outlet_id,
              t.is_delete_requested,
              c.name AS customer_name, c.phone AS customer_phone,
              o.name AS outlet_name, o.full_name AS outlet_full_name
       FROM tr_payment_void_request v
       JOIN tr_transaction t ON t.id = v.transaction_id
       LEFT JOIN mst_customer c ON c.id = t.customer_id
       LEFT JOIN mst_outlet o ON o.id = t.outlet_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY v.requested_at DESC, v.id DESC
       LIMIT 500`,
      params
    );
    const names = await employeeNames(rows.flatMap((r) => [r.requested_by_employee_id, r.reviewed_by_employee_id]));
    const data = rows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      orderNo: r.order_no,
      orderDate: r.order_date,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      outletId: r.outlet_id,
      branch: r.outlet_full_name || r.outlet_name,
      grandTotal: num(r.grand_total),
      paidAmount: num(r.paid_amount),
      paymentStatus: r.payment_status,
      paymentLogId: r.payment_log_id,
      logType: r.log_type,
      amount: num(r.amount),
      paymentMethod: r.payment_method,
      paidAt: r.paid_at,
      reason: r.reason,
      attachmentUrl: posFileUrl(r.attachment_url),
      status: r.status,
      requestedAt: r.requested_at,
      requestedByName: names[r.requested_by_employee_id] || null,
      reviewedAt: r.reviewed_at,
      reviewedByName: names[r.reviewed_by_employee_id] || null,
      reviewNotes: r.review_notes,
      depositRestored: Boolean(r.deposit_mutation_id),
    }));
    res.json({ success: true, data });
  } catch (err) {
    if (err?.code === "ER_NO_SUCH_TABLE") return res.json({ success: true, data: [] });
    console.error("getPaymentVoids error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

async function loadPendingVoid(conn, voidId) {
  const [rows] = await conn.query(
    `SELECT v.*, t.order_no FROM tr_payment_void_request v
     JOIN tr_transaction t ON t.id = v.transaction_id
     WHERE v.id = ? FOR UPDATE`,
    [voidId]
  );
  if (!rows.length) {
    const err = new Error("Pengajuan hapus pelunasan tidak ditemukan");
    err.status = 404;
    throw err;
  }
  if (rows[0].status !== "Pending") {
    const err = new Error(`Pengajuan sudah ${rows[0].status === "Approved" ? "disetujui" : "ditolak"}`);
    err.status = 400;
    throw err;
  }
  return rows[0];
}

/** PATCH /waschen/transactions/payment-voids/:voidId/approve { notes? } */
export const approvePaymentVoid = async (req, res) => {
  let conn;
  try {
    const employee = await sessionEmployee(req);
    const notes = String(req.body?.notes || "").trim().slice(0, 500);
    conn = await myWaschenPool.getConnection();
    await conn.beginTransaction();
    const v = await loadPendingVoid(conn, req.params.voidId);

    const [[order]] = await conn.query("SELECT * FROM tr_transaction WHERE id = ? FOR UPDATE", [v.transaction_id]);
    const amount = num(v.amount);
    const trail = `Dibatalkan via Hapus Pelunasan oleh ${employee.full_name}${notes ? ` — ${notes}` : ""}`;

    if (v.payment_log_id) {
      const [[log]] = await conn.query(
        `SELECT id, log_type, amount FROM tr_payment_log WHERE id = ? AND transaction_id = ? FOR UPDATE`,
        [v.payment_log_id, v.transaction_id]
      );
      if (!log || !["DP", "Lunas", "Pelunasan"].includes(log.log_type)) {
        const err = new Error("Pembayaran ini sudah tidak aktif (mungkin sudah dibatalkan)");
        err.status = 409;
        throw err;
      }
      await conn.query(
        `UPDATE tr_payment_log SET log_type = 'Dibatalkan',
           notes = CONCAT(COALESCE(notes, ''), IF(COALESCE(notes, '') = '', '', ' | '), ?)
         WHERE id = ?`,
        [`[${log.log_type}] ${trail}`, log.id]
      );
    } else {
      // Nota lama tanpa log: jejak pembatalan di tanggal bayar aslinya
      await conn.query(
        `INSERT INTO tr_payment_log (transaction_id, log_type, amount, payment_method, notes, cashier_employee_id, created_at)
         VALUES (?, 'Dibatalkan', ?, ?, ?, ?, COALESCE(?, NOW()))`,
        [v.transaction_id, amount, v.payment_method, `[${v.log_type}] ${trail}`, order.settled_by_employee_id || order.cashier_employee_id || null, v.paid_at]
      );
    }

    const newPaid = Math.max(0, num(order.paid_amount) - amount);
    const newStatus = resolvePaymentStatus(newPaid, num(order.grand_total));
    const [[prevLog]] = await conn.query(
      `SELECT payment_method FROM tr_payment_log
       WHERE transaction_id = ? AND log_type IN ${REVENUE_TYPES} AND amount > 0
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [v.transaction_id]
    );
    const stillLunas = newStatus === "Lunas";
    await conn.query(
      `UPDATE tr_transaction SET
         paid_amount = ?,
         payment_status = ?,
         payment_method = ?,
         paid_at = ${stillLunas ? "paid_at" : "NULL"},
         settled_by_employee_id = ${stillLunas ? "settled_by_employee_id" : "NULL"},
         settled_at = ${stillLunas ? "settled_at" : "NULL"},
         updated_at = NOW()
       WHERE id = ?`,
      [newPaid, newStatus, newPaid > 0 ? prevLog?.payment_method || order.payment_method : null, v.transaction_id]
    );

    // Potong Saldo Member → saldo dikembalikan
    let depositMutationId = null;
    if (isMemberBalance(v.payment_method) && order.customer_id && amount > 0) {
      const [[cust]] = await conn.query("SELECT deposit_balance FROM mst_customer WHERE id = ? FOR UPDATE", [order.customer_id]);
      const before = num(cust?.deposit_balance);
      const after = before + amount;
      await conn.query("UPDATE mst_customer SET deposit_balance = ?, updated_at = NOW() WHERE id = ?", [after, order.customer_id]);
      const [dep] = await conn.query(
        `INSERT INTO tr_customer_deposit
         (customer_id, order_id, outlet_id, cashier_employee_id, type, amount, balance_before, balance_after, payment_method, notes)
         VALUES (?, ?, ?, ?, 'Refund', ?, ?, ?, ?, ?)`,
        [order.customer_id, order.id, order.outlet_id, employee.employee_id, amount, before, after, v.payment_method,
          `Pengembalian saldo — hapus pelunasan nota ${order.order_no}`]
      );
      depositMutationId = dep.insertId;
    }

    await conn.query(
      `UPDATE tr_payment_void_request SET status = 'Approved', reviewed_by_employee_id = ?, reviewed_at = NOW(),
         review_notes = ?, deposit_mutation_id = ?
       WHERE id = ?`,
      [employee.employee_id, notes || null, depositMutationId, v.id]
    );
    await conn.commit();

    res.json({
      success: true,
      message: `Pelunasan nota ${order.order_no} dihapus — status bayar sekarang ${newStatus === "Outstanding" ? "Belum Bayar" : newStatus}${depositMutationId ? ", saldo member dikembalikan" : ""}`,
      data: { orderNo: order.order_no, paidAmount: newPaid, paymentStatus: newStatus, depositRestored: Boolean(depositMutationId) },
    });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error("approvePaymentVoid error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
};

/** PATCH /waschen/transactions/payment-voids/:voidId/reject { notes? } */
export const rejectPaymentVoid = async (req, res) => {
  let conn;
  try {
    const employee = await sessionEmployee(req);
    const notes = String(req.body?.notes || "").trim().slice(0, 500);
    conn = await myWaschenPool.getConnection();
    await conn.beginTransaction();
    const v = await loadPendingVoid(conn, req.params.voidId);
    await conn.query(
      `UPDATE tr_payment_void_request SET status = 'Rejected', reviewed_by_employee_id = ?, reviewed_at = NOW(), review_notes = ?
       WHERE id = ?`,
      [employee.employee_id, notes || null, v.id]
    );
    await conn.commit();
    res.json({ success: true, message: `Pengajuan hapus pelunasan nota ${v.order_no} ditolak — pembayaran tetap` });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error("rejectPaymentVoid error:", err);
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally {
    if (conn) conn.release();
  }
};
