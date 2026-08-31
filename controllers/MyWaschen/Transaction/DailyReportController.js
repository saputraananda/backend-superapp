import { safeMyWaschenQuery, safeQuery } from "../../../db/pool.js";

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

async function loadVerifiedTransactions(shiftId) {
  const [rows] = await safeMyWaschenQuery(
    `SELECT v.id, v.shift_id, v.transaction_id, v.verified_by, v.verified_at,
            t.order_no, t.grand_total, t.payment_method, t.payment_status,
            c.name AS customer_name
     FROM tr_shift_txn_verify v
     JOIN tr_transaction t ON t.id = v.transaction_id
     LEFT JOIN mst_customer c ON c.id = t.customer_id
     WHERE v.shift_id = ?
     ORDER BY v.verified_at ASC`,
    [shiftId]
  );
  return rows.map((r) => ({
    id: r.id,
    shiftId: r.shift_id,
    transactionId: r.transaction_id,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
    orderNo: r.order_no,
    grandTotal: num(r.grand_total),
    paymentMethod: r.payment_method,
    paymentStatus: r.payment_status,
    customerName: r.customer_name,
  }));
}

/** GET /waschen/daily-report */
export async function getDailyReportList(req, res) {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const date = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);

    const params = [date];
    let sql = `${SHIFT_SELECT} WHERE DATE(s.opened_at) = ?`;
    if (outletId) {
      sql += " AND s.outlet_id = ?";
      params.push(outletId);
    }
    sql += " ORDER BY s.outlet_id ASC, s.shift_number ASC, s.id ASC";

    const [rows] = await safeMyWaschenQuery(sql, params);
    const empIds = rows.flatMap((r) => [
      r.cashier_employee_id,
      r.closed_by_employee_id,
      r.last_active_employee_id,
    ]);
    const nameMap = await getEmployeeNameMap(empIds);

    const data = [];
    for (const row of rows) {
      const enriched = await enrichShiftRow(row, nameMap);
      const verifiedTransactions = await loadVerifiedTransactions(row.id);
      data.push({ ...enriched, verifiedTransactions });
    }

    return res.json({
      success: true,
      data,
      meta: { outletId, date, total: data.length },
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
    ]);
    const data = await enrichShiftRow(row, nameMap);
    data.verifiedTransactions = await loadVerifiedTransactions(id);
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
    ]);
    const data = await enrichShiftRow(row, nameMap);
    data.verifiedTransactions = await loadVerifiedTransactions(id);

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
