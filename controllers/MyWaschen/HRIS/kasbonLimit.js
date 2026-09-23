import { safeQuery, safeMyWaschenQuery } from "../../../db/pool.js";

function pad(n) {
  return String(n).padStart(2, "0");
}

function wibParts(date = new Date()) {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

function shiftMonth(y, m, delta) {
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1 };
}

export function currentCutoff(date = new Date()) {
  const { y, m, d } = wibParts(date);
  const end = d >= 26 ? shiftMonth(y, m, 1) : { y, m };
  const start = shiftMonth(end.y, end.m, -1);
  return {
    start: `${start.y}-${pad(start.m)}-26`,
    end: `${end.y}-${pad(end.m)}-25`,
    year: end.y,
    month: end.m,
  };
}

export function cutoffEndOffset(offset, date = new Date()) {
  const cur = currentCutoff(date);
  const shifted = shiftMonth(cur.year, cur.month, offset);
  return `${shifted.y}-${pad(shifted.m)}-25`;
}

export function splitInstallments(total, tenor) {
  const n = Math.max(1, Math.floor(Number(tenor) || 1));
  const whole = Math.round(Number(total) || 0);
  const each = Math.floor(whole / n);
  const amounts = Array.from({ length: n }, () => each);
  amounts[n - 1] = whole - each * (n - 1);
  return amounts;
}

export async function getEmployeeSalary(employeeId) {
  const [rows] = await safeQuery(
    "SELECT employee_id, full_name, basic_salary FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1",
    [employeeId]
  );
  return rows[0] || null;
}

export async function reservedAmount(employeeId, excludeId = null) {
  const exclude = excludeId ? " AND k.id <> ?" : "";
  const params = excludeId ? [employeeId, excludeId] : [employeeId];
  const [pending] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(k.amount_requested), 0) AS hold
     FROM tr_kasbon k
     WHERE k.employee_id = ? AND k.status IN ('pengajuan','proses')${exclude}`,
    params
  );
  const [open] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(p.amount), 0) AS hold
     FROM tr_kasbon_payment p
     JOIN tr_kasbon k ON k.id = p.kasbon_id
     WHERE k.employee_id = ? AND k.status = 'disetujui' AND p.status = 'belum'${exclude}`,
    params
  );
  const [legacy] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(COALESCE(k.amount_approved, k.amount_requested)), 0) AS hold
     FROM tr_kasbon k
     WHERE k.employee_id = ? AND k.status = 'disetujui'${exclude}
       AND NOT EXISTS (SELECT 1 FROM tr_kasbon_payment p WHERE p.kasbon_id = k.id)`,
    params
  );
  return Number(pending[0].hold) + Number(open[0].hold) + Number(legacy[0].hold);
}

export async function buildKasbonSummary(employeeId, excludeId = null) {
  const emp = await getEmployeeSalary(employeeId);
  const salary = Number(emp?.basic_salary) || 0;
  const limit = Math.floor(salary / 2);
  const cutoff = currentCutoff();
  const reserved = await reservedAmount(employeeId, excludeId);
  const exclude = excludeId ? " AND k.id <> ?" : "";
  const dueParams = excludeId ? [employeeId, cutoff.end, excludeId] : [employeeId, cutoff.end];
  const pendingParams = excludeId ? [employeeId, excludeId] : [employeeId];
  const [dueRows] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(p.amount), 0) AS due
     FROM tr_kasbon_payment p
     JOIN tr_kasbon k ON k.id = p.kasbon_id
     WHERE k.employee_id = ? AND k.status = 'disetujui'
       AND p.status = 'belum' AND p.due_date <= ?${exclude}`,
    dueParams
  );
  const [pendingRows] = await safeMyWaschenQuery(
    `SELECT COALESCE(SUM(k.amount_requested), 0) AS hold
     FROM tr_kasbon k
     WHERE k.employee_id = ? AND k.status IN ('pengajuan','proses')${exclude}`,
    pendingParams
  );
  return {
    basicSalary: salary,
    limit,
    sekarang: (Number(dueRows[0].due) || 0) + (Number(pendingRows[0].hold) || 0),
    reserved,
    sisa: Math.max(0, limit - reserved),
    cutoffStart: cutoff.start,
    cutoffEnd: cutoff.end,
    hasSalary: salary > 0,
    employeeName: emp?.full_name || null,
  };
}

export async function insertSchedule({ kasbonId, amounts, currentIndex, paymentMethod, actorName }, query = safeMyWaschenQuery) {
  for (let i = 0; i < amounts.length; i++) {
    const due = cutoffEndOffset(i - currentIndex);
    const alreadyPaid = i < currentIndex;
    await query(
      `INSERT INTO tr_kasbon_payment
        (kasbon_id, installment_no, payment_date, due_date, amount, payment_method, status, paid_at, recorded_by_name, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kasbonId,
        i + 1,
        due,
        due,
        amounts[i],
        paymentMethod,
        alreadyPaid ? "terbayar" : "belum",
        alreadyPaid ? new Date() : null,
        alreadyPaid ? actorName : null,
        alreadyPaid ? "Saldo awal — termin sudah lunas sebelum sistem" : null,
      ]
    );
  }
}
