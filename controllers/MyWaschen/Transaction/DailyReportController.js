import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";
import { posFileUrl } from "../../../utils/waschenPosUpload.js";

/** Batas upload bukti setoran tunai: H+1 dari tanggal closing (sama dengan POS). */
const DEPOSIT_DUE_DAYS = 1;

/** YYYY-MM-DD menurut kalender WIB. */
function wibDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function dayDiff(laterKey, earlierKey) {
  if (!laterKey || !earlierKey) return 0;
  return Math.round((Date.parse(`${laterKey}T00:00:00Z`) - Date.parse(`${earlierKey}T00:00:00Z`)) / 86400000);
}

/** Status setoran tunai closing Final: null jika bukan closing Final. */
function buildDepositInfo(row, nameMap) {
  if (row.status !== "Closed" || row.close_type !== "Final" || !row.closed_at) return null;
  const uploaded = Boolean(row.deposit_proof_url);
  const refKey = uploaded
    ? wibDateKey(row.deposit_uploaded_at) || wibDateKey(new Date())
    : wibDateKey(new Date());
  const lateDays = Math.max(0, dayDiff(refKey, wibDateKey(row.closed_at)) - DEPOSIT_DUE_DAYS);
  return {
    status: uploaded ? "uploaded" : "pending",
    isLate: lateDays > 0,
    lateDays,
    proofUrl: posFileUrl(row.deposit_proof_url),
    notes: row.deposit_notes || null,
    uploadedAt: row.deposit_uploaded_at || null,
    uploadedBy: row.deposit_uploaded_by || null,
    uploadedByName: formatEmployeeLabel(row.deposit_uploaded_by, nameMap),
  };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getEmployeeNameMap(ids = []) {
  const unique = [...new Set(ids.filter(Boolean).map(Number))];
  if (!unique.length) return {};
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name FROM mst_employee
     WHERE employee_id IN (${unique.map(() => "?").join(",")})`,
    unique
  );
  return Object.fromEntries(rows.map((r) => [r.employee_id, r.full_name]));
}

function formatEmployeeLabel(employeeId, nameMap) {
  if (!employeeId) return null;
  return nameMap[employeeId] || `Karyawan #${employeeId}`;
}

async function enrichShiftRow(row, nameMap) {
  if (!row) return null;
  return {
    id: row.id,
    outletId: row.outlet_id,
    cashierEmployeeId: row.cashier_employee_id,
    closedByEmployeeId: row.closed_by_employee_id,
    lastActiveEmployeeId: row.last_active_employee_id,
    lastActiveAt: row.last_active_at,
    shiftNumber: row.shift_number,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    previousCash: num(row.previous_cash),
    previousPettyCash: num(row.previous_petty_cash),
    initialCash: num(row.initial_cash),
    initialPettyCash: num(row.initial_petty_cash),
    openImbalanceReason: row.open_imbalance_reason,
    systemCashRevenue: num(row.system_cash_revenue),
    systemCashExpense: num(row.system_cash_expense),
    expectedCash: num(row.expected_cash),
    actualCash: row.actual_cash != null ? num(row.actual_cash) : null,
    actualPettyCash: row.actual_petty_cash != null ? num(row.actual_petty_cash) : null,
    declaredRevenue: row.declared_revenue != null ? num(row.declared_revenue) : null,
    difference: num(row.difference),
    closeType: row.close_type,
    closingNotes: row.closing_notes,
    reportText: row.report_text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openerName: formatEmployeeLabel(row.cashier_employee_id, nameMap),
    closedByName: formatEmployeeLabel(row.closed_by_employee_id, nameMap),
    lastActiveName: formatEmployeeLabel(row.last_active_employee_id, nameMap),
    deposit: buildDepositInfo(row, nameMap),
    outletCode: row.outlet_code,
    outletName: row.outlet_name,
    outletFullName: row.outlet_full_name,
  };
}

const SHIFT_SELECT = `
  SELECT s.*,
         o.outlet_code, o.name AS outlet_name, o.full_name AS outlet_full_name
  FROM tr_cashier_shift s
  LEFT JOIN mst_outlet o ON o.id = s.outlet_id
`;

/** Nota yang dibayar (DP/Lunas/Pelunasan) di rentang shift, sama dengan POS. Nota baru outstanding tidak masuk. */
async function loadShiftTransactions(shift) {
  const [rows] = await safeMyWaschenQuery(
    `SELECT t.id, t.order_no, t.payment_status,
            c.name AS customer_name,
            COALESCE(NULLIF(TRIM(c.full_address), ''), NULLIF(TRIM(c.address), '')) AS customer_address,
            p.paid_here, p.methods, p.last_paid_at,
            CASE WHEN v.id IS NOT NULL THEN 1 ELSE 0 END AS is_verified,
            v.verified_by, v.verified_at
     FROM (
       SELECT transaction_id, SUM(amount) AS paid_here,
              GROUP_CONCAT(DISTINCT payment_method SEPARATOR ', ') AS methods,
              MAX(created_at) AS last_paid_at
       FROM tr_payment_log
       WHERE log_type IN ('DP','Lunas','Pelunasan')
         AND created_at >= ? AND created_at <= COALESCE(?, NOW())
       GROUP BY transaction_id
     ) p
     JOIN tr_transaction t ON t.id = p.transaction_id
     LEFT JOIN mst_customer c ON c.id = t.customer_id
     LEFT JOIN tr_shift_txn_verify v ON v.transaction_id = t.id AND v.shift_id = ?
     WHERE t.outlet_id = ? AND t.is_delete_requested = 0
     ORDER BY p.last_paid_at ASC`,
    [shift.opened_at, shift.closed_at || null, shift.id, shift.outlet_id]
  );
  return rows.map((r) => ({
    id: r.id,
    orderNo: r.order_no,
    paymentStatus: r.payment_status,
    customerName: r.customer_name,
    customerAddress: r.customer_address,
    paidHere: num(r.paid_here),
    paymentMethod: r.methods || null,
    lastPaidAt: r.last_paid_at,
    isVerified: Number(r.is_verified) === 1,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
  }));
}
/** GET /waschen/daily-report */
export async function getDailyReportList(req, res) {
  try {
    const outletIds = String(req.query.outletId || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
    const today = new Date().toISOString().slice(0, 10);
    const dateFrom = String(req.query.dateFrom || req.query.date || today).slice(0, 10);
    const dateTo = String(req.query.dateTo || req.query.date || dateFrom).slice(0, 10);

    const params = [dateFrom, dateTo];
    let sql = `${SHIFT_SELECT} WHERE DATE(s.opened_at) >= ? AND DATE(s.opened_at) <= ?`;
    if (outletIds.length) {
      sql += ` AND s.outlet_id IN (${outletIds.map(() => "?").join(",")})`;
      params.push(...outletIds);
    }
    sql += " ORDER BY s.outlet_id ASC, s.shift_number ASC, s.id ASC";

    const [rows] = await safeMyWaschenQuery(sql, params);
    const empIds = rows.flatMap((r) => [
      r.cashier_employee_id,
      r.closed_by_employee_id,
      r.last_active_employee_id,
      r.deposit_uploaded_by,
    ]);
    const nameMap = await getEmployeeNameMap(empIds);

    const data = [];
    for (const row of rows) {
      const enriched = await enrichShiftRow(row, nameMap);
      const transactions = await loadShiftTransactions(row);
      data.push({ ...enriched, transactions });
    }

    return res.json({
      success: true,
      data,
      meta: { outletIds, dateFrom, dateTo, total: data.length },
    });
  } catch (err) {
    console.error("getDailyReportList:", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Gagal memuat daily report",
    });
  }
}

/** GET /waschen/daily-report/:id */
export async function getDailyReportById(req, res) {
  try {
    const id = Number(req.params.id);
    const [rows] = await safeMyWaschenQuery(`${SHIFT_SELECT} WHERE s.id = ? LIMIT 1`, [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Shift tidak ditemukan" });
    }
    const row = rows[0];
    const nameMap = await getEmployeeNameMap([
      row.cashier_employee_id,
      row.closed_by_employee_id,
      row.last_active_employee_id,
      row.deposit_uploaded_by,
    ]);
    const data = await enrichShiftRow(row, nameMap);
    data.transactions = await loadShiftTransactions(row);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getDailyReportById:", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Gagal memuat detail shift",
    });
  }
}

/** PUT /waschen/daily-report/:id — admin koreksi saldo / laporan */
export async function updateDailyReportShift(req, res) {
  try {
    const id = Number(req.params.id);
    const {
      initialCash,
      initialPettyCash,
      actualCash,
      actualPettyCash,
      declaredRevenue,
      openImbalanceReason,
      closingNotes,
      reportText,
    } = req.body;

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_cashier_shift WHERE id = ? LIMIT 1", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Shift tidak ditemukan" });
    }
    const shift = rows[0];

    const nextInitialCash = initialCash !== undefined ? num(initialCash) : num(shift.initial_cash);
    const nextInitialPetty = initialPettyCash !== undefined ? num(initialPettyCash) : num(shift.initial_petty_cash);
    const nextActualCash = actualCash !== undefined ? num(actualCash) : (shift.actual_cash != null ? num(shift.actual_cash) : null);
    const nextActualPetty = actualPettyCash !== undefined ? num(actualPettyCash) : (shift.actual_petty_cash != null ? num(shift.actual_petty_cash) : null);
    const nextDeclaredRevenue = declaredRevenue !== undefined ? num(declaredRevenue) : (shift.declared_revenue != null ? num(shift.declared_revenue) : null);

    const expected = num(shift.expected_cash);
    const nextDifference = nextActualCash != null && expected ? nextActualCash - expected : num(shift.difference);

    await safeMyWaschenQuery(
      `UPDATE tr_cashier_shift SET
         initial_cash = ?,
         initial_petty_cash = ?,
         actual_cash = ?,
         actual_petty_cash = ?,
         declared_revenue = ?,
         difference = ?,
         open_imbalance_reason = COALESCE(?, open_imbalance_reason),
         closing_notes = COALESCE(?, closing_notes),
         report_text = COALESCE(?, report_text),
         updated_at = NOW()
       WHERE id = ?`,
      [
        nextInitialCash,
        nextInitialPetty,
        nextActualCash,
        nextActualPetty,
        nextDeclaredRevenue,
        nextDifference,
        openImbalanceReason !== undefined ? (openImbalanceReason || null) : shift.open_imbalance_reason,
        closingNotes !== undefined ? (closingNotes || null) : shift.closing_notes,
        reportText !== undefined ? (reportText || null) : shift.report_text,
        id,
      ]
    );

    const [updated] = await safeMyWaschenQuery(`${SHIFT_SELECT} WHERE s.id = ? LIMIT 1`, [id]);
    const row = updated[0];
    const nameMap = await getEmployeeNameMap([
      row.cashier_employee_id,
      row.closed_by_employee_id,
      row.last_active_employee_id,
      row.deposit_uploaded_by,
    ]);
    const data = await enrichShiftRow(row, nameMap);
    data.transactions = await loadShiftTransactions(row);

    return res.json({
      success: true,
      message: "Laporan shift berhasil diperbarui",
      data,
    });
  } catch (err) {
    console.error("updateDailyReportShift:", err);
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Gagal memperbarui daily report",
    });
  }
}
