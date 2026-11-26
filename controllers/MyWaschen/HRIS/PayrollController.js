// ════════════════════════════════════════════════════════════════════════════
// PAYROLL WASCHEN — Rekap data penggajian per karyawan per periode (cutoff 26–25)
//
// Sumber (DB myWaschen): tr_attendance, tr_employee_day_off, tr_overtime, tr_leave,
// tr_kasbon + tr_kasbon_payment, mst_role, mst_outlet, mst_location_absen.
// Nama / kode / tanggal masuk-keluar dari mst_employee (DB utama, company_id = 5).
//
// Aturan hitung (selaras dengan halaman HRIS lain):
//   Hadir            = tanggal dengan check-in
//   Terlambat        = check-in setelah 08:00; Frontliner ikut jam mulai shift (Pagi/Siang,
//                      shift kosong = Pagi) — attendanceShift.js
//   Pulang cepat     = Frontliner check-out sebelum jam selesai shift
//                      Sama dengan Dashboard HR. Telat tidak dihitung
//                      bila hari itu ada izin/sakit/cuti ½ hari pagi yang disetujui
//   Durasi kerja     = check-out − check-in (hanya absensi yang lengkap)
//   Off              = jadwal libur berstatus 'disetujui' (HRD)
//   Backup           = libur rekan ('disetujui') yang menunjuk karyawan ini sebagai backup
//   Lembur           = dihitung yang 'disetujui'; status lain tetap tampil di detail
//   Perizinan        = hari izin/sakit/cuti 'disetujui' di periode (setengah hari = 0,5)
//   Tanpa keterangan = hari sampai kemarin tanpa absen, libur, maupun izin yang disetujui
//   Kasbon/Pinjaman  = beban periode = termin jatuh tempo di periode + tunggakan termin
//                      sebelumnya yang belum lunas (+ kasbon lama tanpa jadwal termin).
//                      Hanya metode 'potong_gaji' yang masuk potongan gaji; 'langsung'
//                      ditampilkan terpisah (dibayar sendiri oleh karyawan).
//   Daily Worker     = pekerja lepas: tanpa gaji tetap, jatah libur, maupun kasbon. Hari tanpa
//                      absen = "tidak bekerja" (bukan tanpa keterangan). Payroll-nya = jam kerja
//                      + pengerjaan: nota yang dia buat (kasir) + item yang dia QC di semua tahap
//                      (tr_item_progress), lengkap dengan kg untuk item kiloan.
// ════════════════════════════════════════════════════════════════════════════

import { safeQuery, safeMyWaschenQuery } from "../../../db/pool.js";
import { defaultCutoffDateRange } from "../utils/cutoffHelpers.js";
import { toISODate, resolveMstRoleEmployeeIds, getEmployeeNameMap, DAILY_WORKER_ROLE } from "./hrisHelpers.js";
import { loadShiftMap, evaluateShift } from "./attendanceShift.js";

const WASCHEN_COMPANY_ID = 5;
const OFF_WAITING = ["pengajuan", "disetujui_leader", "ditolak_leader"]; // menunggu keputusan HRD
const MAX_RANGE_DAYS = 93;

const ph = (arr) => arr.map(() => "?").join(",");
const num = (v) => Number(v) || 0;
const hhmm = (dt) => (dt ? String(dt).slice(11, 16) : null);

// Tanggal hari ini versi WIB (UTC+7), tidak tergantung zona waktu server
function todayISO() {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function shiftISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function eachDate(from, to) {
  const out = [];
  for (let cur = from; cur <= to; cur = shiftISO(cur, 1)) out.push(cur);
  return out;
}

function resolvePeriod(query) {
  const def = defaultCutoffDateRange();
  const startDate = toISODate(query.startDate) || def.dateFrom;
  const endDate = toISODate(query.endDate) || def.dateTo;
  if (startDate > endDate) {
    const err = new Error("Tanggal mulai melebihi tanggal akhir");
    err.statusCode = 400;
    throw err;
  }
  if (eachDate(startDate, endDate).length > MAX_RANGE_DAYS) {
    const err = new Error(`Rentang tanggal maksimal ${MAX_RANGE_DAYS} hari`);
    err.statusCode = 400;
    throw err;
  }
  return { startDate, endDate };
}

// Durasi lembur (menit). Pakai start_at/end_at; fallback jam (lewat tengah malam didukung).
function overtimeMinutes(r) {
  if (r.dur_min != null) return num(r.dur_min);
  if (r.status === "berlangsung") return 0;
  const toMin = (t) => {
    const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const s = toMin(r.start_time);
  const e = toMin(r.end_time);
  if (s == null || e == null) return 0;
  return e >= s ? e - s : e + 1440 - s;
}

// ── Karyawan target ─────────────────────────────────────────────────────────
async function loadEmployees({ startDate, endDate, outletId, role, employeeId, search }) {
  const roleIds = await resolveMstRoleEmployeeIds(outletId, role);
  if (roleIds && roleIds.length === 0) return [];

  let rows;
  if (employeeId) {
    [rows] = await safeQuery(
      `SELECT employee_id, employee_code, full_name, join_date, exit_date
       FROM mst_employee WHERE employee_id = ? LIMIT 1`,
      [employeeId],
    );
  } else {
    // Karyawan Waschen yang aktif di periode + siapa pun yang tercatat absen di periode
    const [attEmp] = await safeMyWaschenQuery(
      `SELECT DISTINCT employee_id FROM tr_attendance WHERE work_date BETWEEN ? AND ?`,
      [startDate, endDate],
    );
    const attIds = attEmp.map((r) => Number(r.employee_id)).filter(Boolean);
    [rows] = await safeQuery(
      `SELECT employee_id, employee_code, full_name, join_date, exit_date
       FROM mst_employee
       WHERE (company_id = ? AND is_deleted = 0
              AND (exit_date IS NULL OR exit_date >= ?)
              AND (join_date IS NULL OR join_date <= ?))
          ${attIds.length ? `OR employee_id IN (${ph(attIds)})` : ""}
       ORDER BY full_name ASC`,
      [WASCHEN_COMPANY_ID, startDate, endDate, ...attIds],
    );
  }

  let list = rows.map((r) => ({
    employee_id: Number(r.employee_id),
    employee_code: r.employee_code || null,
    employee_name: r.full_name || `#${r.employee_id}`,
    join_date: toISODate(r.join_date),
    exit_date: toISODate(r.exit_date),
  }));
  if (roleIds) {
    const allowed = new Set(roleIds);
    list = list.filter((e) => allowed.has(e.employee_id));
  }
  const q = String(search || "").trim().toLowerCase();
  if (q) {
    list = list.filter((e) =>
      e.employee_name.toLowerCase().includes(q) || String(e.employee_code || "").toLowerCase().includes(q));
  }
  return list;
}

// ── Semua aktivitas periode untuk sekumpulan karyawan (sekali query per tabel) ──
async function loadActivity(ids, startDate, endDate) {
  const group = (rows, key = "employee_id") => {
    const map = new Map();
    rows.forEach((r) => {
      const k = Number(r[key]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    });
    return map;
  };
  const inIds = ph(ids);

  const [
    [roles], [attendance], [dayOffs], [overtime], [leaves], [kasbon], [outlets], [locations],
  ] = await Promise.all([
    safeMyWaschenQuery(
      `SELECT employee_id, role, outlet_id, is_leader FROM mst_role WHERE employee_id IN (${inIds})`, ids),
    safeMyWaschenQuery(
      `SELECT attendance_id, employee_id, outlet_id, work_date, check_in_time, check_out_time,
              check_in_note, check_out_note, shift_code,
              CASE WHEN check_in_time IS NOT NULL AND check_out_time > check_in_time
                   THEN TIMESTAMPDIFF(MINUTE, check_in_time, check_out_time) END AS work_min
       FROM tr_attendance
       WHERE employee_id IN (${inIds}) AND work_date BETWEEN ? AND ?
       ORDER BY work_date ASC, check_in_time ASC`,
      [...ids, startDate, endDate]),
    safeMyWaschenQuery(
      `SELECT day_off_id, employee_id, off_date, status, reason, backup_employee_id
       FROM tr_employee_day_off
       WHERE off_date BETWEEN ? AND ?
         AND (employee_id IN (${inIds}) OR backup_employee_id IN (${inIds}))
       ORDER BY off_date ASC`,
      [startDate, endDate, ...ids, ...ids]),
    safeMyWaschenQuery(
      `SELECT id, employee_id, outlet_id, overtime_date, start_at, end_at, start_time, end_time,
              reason, work_note, status, reviewed_by_name, approval_note, rejection_note,
              CASE WHEN end_at IS NOT NULL AND end_at > start_at
                   THEN TIMESTAMPDIFF(MINUTE, start_at, end_at) END AS dur_min
       FROM tr_overtime
       WHERE employee_id IN (${inIds}) AND overtime_date BETWEEN ? AND ?
       ORDER BY overtime_date ASC, start_time ASC`,
      [...ids, startDate, endDate]),
    safeMyWaschenQuery(
      `SELECT leave_id, employee_id, leave_type, duration_type, start_date, end_date, reason, status, rejection_note
       FROM tr_leave
       WHERE employee_id IN (${inIds}) AND end_date >= ? AND start_date <= ?
       ORDER BY start_date ASC`,
      [...ids, startDate, endDate]),
    // Kasbon/pinjaman yang relevan: diajukan di periode, ada termin jatuh tempo di periode,
    // masih punya termin belum terbayar, atau disetujui tanpa jadwal termin (data lama).
    safeMyWaschenQuery(
      `SELECT k.id, k.employee_id, k.type, k.submission_date, k.amount_requested, k.amount_approved,
              k.payment_method, k.tenor_count, k.installment_amount, k.is_opening_balance, k.purpose,
              k.notes, k.status, k.approved_by_name, k.approved_at, k.approved_note, k.rejection_note
       FROM tr_kasbon k
       WHERE k.employee_id IN (${inIds})
         AND (k.submission_date BETWEEN ? AND ?
              OR (k.status = 'disetujui' AND k.submission_date <= ? AND (
                    EXISTS (
                      SELECT 1 FROM tr_kasbon_payment p
                      WHERE p.kasbon_id = k.id
                        AND (p.status = 'belum' OR COALESCE(p.due_date, p.payment_date) BETWEEN ? AND ?))
                    OR NOT EXISTS (SELECT 1 FROM tr_kasbon_payment p WHERE p.kasbon_id = k.id))))
       ORDER BY k.submission_date ASC, k.id ASC`,
      [...ids, startDate, endDate, endDate, startDate, endDate]),
    safeMyWaschenQuery(`SELECT id, outlet_code, name FROM mst_outlet`),
    safeMyWaschenQuery(`SELECT id, location_id, location_name FROM mst_location_absen`).catch(() => [[]]),
  ]);

  const kasbonIds = kasbon.map((k) => Number(k.id));
  let payments = [];
  if (kasbonIds.length) {
    [payments] = await safeMyWaschenQuery(
      `SELECT id, kasbon_id, installment_no, due_date, payment_date, amount, payment_method,
              status, paid_at, recorded_by_name, notes
       FROM tr_kasbon_payment WHERE kasbon_id IN (${ph(kasbonIds)})
       ORDER BY installment_no ASC, id ASC`,
      kasbonIds,
    );
  }

  // Nama karyawan yang terlibat di luar daftar (rekan yang libur saat karyawan ini jadi backup, dll.)
  const otherIds = dayOffs.flatMap((d) => [d.employee_id, d.backup_employee_id]).filter(Boolean);
  const nameMap = await getEmployeeNameMap(otherIds);

  // Lokasi absen: mst_outlet + lokasi non-outlet (Head Office, IKM, dsb.)
  const placeMap = new Map();
  outlets.forEach((o) => placeMap.set(Number(o.id), { id: Number(o.id), code: o.outlet_code || null, name: o.name, is_outlet: true }));
  locations.forEach((l) => placeMap.set(Number(l.id), { id: Number(l.id), code: l.location_id || null, name: l.location_name, is_outlet: false }));

  const roleById = new Map(roles.map((r) => [Number(r.employee_id), r]));
  const dailyIds = roles.filter((r) => r.role === DAILY_WORKER_ROLE).map((r) => Number(r.employee_id));
  const work = await loadDailyWork(dailyIds, startDate, endDate);
  const shiftMap = await loadShiftMap();
  attendance.forEach((r) => {
    Object.assign(r, evaluateShift(r, roleById.get(Number(r.employee_id))?.role, shiftMap));
  });

  return {
    roles: roleById,
    attendance: group(attendance),
    offsOwn: group(dayOffs),
    offsBackup: group(dayOffs.filter((d) => d.backup_employee_id), "backup_employee_id"),
    overtime: group(overtime),
    leaves: group(leaves),
    kasbon: group(kasbon),
    payments: group(payments, "kasbon_id"),
    nameMap,
    placeMap,
    work,
  };
}

// ── Pengerjaan Daily Worker: nota yang dibuat + QC semua tahap ────────────────
const isKgUnit = (unit) => String(unit || "").trim().toLowerCase() === "kg";
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const WORK_STAGES = ["frontliner", "washing", "ironing", "packing", "delivery", "handover"];

function addQty(target, unit, qty) {
  const q = Number(qty) || 0;
  if (isKgUnit(unit)) target.kg = round2(target.kg + q);
  else {
    const u = String(unit || "Item").trim() || "Item";
    target.units[u] = round2((target.units[u] || 0) + q);
  }
}

async function loadDailyWork(ids, startDate, endDate) {
  const empty = { notas: new Map(), qc: new Map() };
  if (!ids.length) return empty;
  const inIds = ph(ids);
  const from = `${startDate} 00:00:00`;
  const to = `${endDate} 23:59:59`;
  const notDeleted = "NOT (COALESCE(t.is_delete_requested, 0) = 1 AND t.delete_approval_status = 1)";

  const [[notaRows], [notaItems], [qcRows]] = await Promise.all([
    safeMyWaschenQuery(
      `SELECT t.id, t.order_no, t.cashier_employee_id AS employee_id, t.order_date, t.is_delivery, t.source
       FROM tr_transaction t
       WHERE t.cashier_employee_id IN (${inIds}) AND t.order_date BETWEEN ? AND ? AND ${notDeleted}
       ORDER BY t.order_date ASC, t.id ASC`,
      [...ids, from, to]),
    safeMyWaschenQuery(
      `SELECT d.transaction_id, d.service_name, d.qty, d.unit
       FROM tr_transaction_detail d
       JOIN tr_transaction t ON t.id = d.transaction_id
       WHERE t.cashier_employee_id IN (${inIds}) AND t.order_date BETWEEN ? AND ? AND ${notDeleted}
         AND COALESCE(d.item_work_status, '') <> 'Dibatalkan'`,
      [...ids, from, to]),
    // Satu baris progress = satu pengerjaan (QC) item di satu tahap. Yang dibatalkan & "Dilewati" (skipped) tidak dihitung.
    safeMyWaschenQuery(
      `SELECT p.id, p.employee_id, p.stage, p.status, p.qc_status, p.transaction_detail_id,
              COALESCE(p.completed_at, p.created_at) AS worked_at,
              t.order_no, d.service_name, d.qty, d.unit
       FROM tr_item_progress p
       JOIN tr_transaction_detail d ON d.id = p.transaction_detail_id
       JOIN tr_transaction t ON t.id = p.transaction_id
       WHERE p.employee_id IN (${inIds}) AND COALESCE(p.status, '') NOT IN ('cancelled', 'skipped')
         AND COALESCE(p.completed_at, p.created_at) BETWEEN ? AND ? AND ${notDeleted}
       ORDER BY worked_at ASC, p.id ASC`,
      [...ids, from, to]),
  ]);

  const itemsByNota = new Map();
  notaItems.forEach((d) => {
    const k = Number(d.transaction_id);
    if (!itemsByNota.has(k)) itemsByNota.set(k, []);
    itemsByNota.get(k).push(d);
  });

  const notas = new Map();
  notaRows.forEach((t) => {
    const qty = { kg: 0, units: {} };
    const items = (itemsByNota.get(Number(t.id)) || []).map((d) => {
      addQty(qty, d.unit, d.qty);
      return { service_name: d.service_name || "Item", qty: round2(d.qty), unit: d.unit || null };
    });
    const k = Number(t.employee_id);
    if (!notas.has(k)) notas.set(k, []);
    notas.get(k).push({
      id: Number(t.id),
      order_no: t.order_no,
      date: toISODate(t.order_date),
      time: hhmm(t.order_date),
      is_delivery: Number(t.is_delivery) === 1,
      source: t.source || "POS",
      kg: qty.kg,
      units: qty.units,
      items,
    });
  });

  const qc = new Map();
  qcRows.forEach((p) => {
    const k = Number(p.employee_id);
    if (!qc.has(k)) qc.set(k, []);
    qc.get(k).push({
      id: Number(p.id),
      date: toISODate(p.worked_at),
      time: hhmm(p.worked_at),
      stage: p.stage,
      status: p.status,
      qc_status: p.qc_status || null,
      order_no: p.order_no,
      service_name: p.service_name || "Item",
      qty: round2(p.qty),
      unit: p.unit || null,
      is_kg: isKgUnit(p.unit),
    });
  });
  return { notas, qc };
}

// Ringkasan pengerjaan: nota (jumlah, kg, satuan) + QC per tahap (jumlah item, kg, satuan)
function summarizeWork(notas, qcList) {
  const nota = { count: notas.length, kg: 0, units: {} };
  notas.forEach((n) => {
    nota.kg = round2(nota.kg + n.kg);
    Object.entries(n.units).forEach(([u, q]) => { nota.units[u] = round2((nota.units[u] || 0) + q); });
  });
  const stages = {};
  WORK_STAGES.forEach((s) => { stages[s] = { count: 0, kg: 0, units: {} }; });
  qcList.forEach((p) => {
    const s = stages[p.stage] || (stages[p.stage] = { count: 0, kg: 0, units: {} });
    s.count += 1;
    addQty(s, p.unit, p.qty);
  });
  const qcTotal = qcList.length;
  const qcKg = round2(Object.values(stages).reduce((t, s) => t + s.kg, 0));
  const days = new Set([...notas.map((n) => n.date), ...qcList.map((p) => p.date)].filter(Boolean));
  return { nota, qc: { total: qcTotal, kg: qcKg, stages }, active_days: days.size };
}

const placeOf = (ctx, id) =>
  ctx.placeMap.get(Number(id)) || { id: Number(id) || null, code: null, name: id ? `Lokasi #${id}` : "—", is_outlet: false };

// ── Hitung satu karyawan ────────────────────────────────────────────────────
function buildEmployee(emp, ctx, startDate, endDate, withDetail) {
  const id = emp.employee_id;
  const today = todayISO();
  const roleRow = ctx.roles.get(id) || null;
  const homeOutletId = roleRow?.outlet_id ? Number(roleRow.outlet_id) : null;
  const home = homeOutletId ? placeOf(ctx, homeOutletId) : null;

  // Absensi — satu tanggal bisa punya >1 record; check-in pertama menentukan terlambat
  const att = ctx.attendance.get(id) || [];
  const byDate = new Map();
  let workMinutes = 0;
  let incomplete = 0;
  const workedDates = new Set(); // tanggal dengan minimal satu absen lengkap (untuk rata-rata)
  const placeCount = new Map();
  let outsideHome = 0;
  att.forEach((r) => {
    const date = toISODate(r.work_date);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
    if (r.check_in_time) {
      if (r.work_min != null) {
        workMinutes += num(r.work_min);
        workedDates.add(date);
      } else if (!r.check_out_time) incomplete += 1;
      const pid = Number(r.outlet_id) || 0;
      placeCount.set(pid, (placeCount.get(pid) || 0) + 1);
      if (homeOutletId && pid && pid !== homeOutletId) outsideHome += 1;
    }
  });
  const hadirDates = new Set([...byDate].filter(([, recs]) => recs.some((r) => r.check_in_time)).map(([d]) => d));

  // Libur & backup
  const offsOwn = (ctx.offsOwn.get(id) || []).filter((d) => Number(d.employee_id) === id);
  const offApproved = offsOwn.filter((d) => d.status === "disetujui");
  const offPending = offsOwn.filter((d) => OFF_WAITING.includes(d.status));
  const offDates = new Set(offApproved.map((d) => toISODate(d.off_date)));
  const backups = (ctx.offsBackup.get(id) || []).filter((d) => d.status === "disetujui");
  const backupByDate = new Map();
  backups.forEach((b) => {
    const d = toISODate(b.off_date);
    if (!backupByDate.has(d)) backupByDate.set(d, []);
    backupByDate.get(d).push(ctx.nameMap.get(Number(b.employee_id))?.full_name || `#${b.employee_id}`);
  });

  // Lembur
  const ot = (ctx.overtime.get(id) || []).map((r) => ({ ...r, minutes: overtimeMinutes(r) }));
  const otApproved = ot.filter((r) => r.status === "disetujui");
  const otMinutes = otApproved.reduce((s, r) => s + r.minutes, 0);
  const otByDate = new Map();
  otApproved.forEach((r) => {
    const d = toISODate(r.overtime_date);
    otByDate.set(d, (otByDate.get(d) || 0) + r.minutes);
  });

  // Perizinan — hari yang jatuh di periode
  const leaveDays = { izin: 0, sakit: 0, cuti: 0 };
  const leaveByDate = new Map();
  const leaves = (ctx.leaves.get(id) || []).map((l) => {
    const from = toISODate(l.start_date) < startDate ? startDate : toISODate(l.start_date);
    const to = toISODate(l.end_date) > endDate ? endDate : toISODate(l.end_date);
    const dates = from <= to ? eachDate(from, to) : [];
    const perDay = l.duration_type === "full_day" ? 1 : 0.5;
    const days = dates.length * perDay;
    if (l.status === "disetujui") {
      leaveDays[l.leave_type] = (leaveDays[l.leave_type] || 0) + days;
      dates.forEach((d) => leaveByDate.set(d, { type: l.leave_type, half: perDay < 1, duration: l.duration_type }));
    }
    return { ...l, days_in_period: days };
  });

  // Terlambat — check-in pertama per tanggal; dikecualikan bila izin ½ hari pagi disetujui
  let lateCount = 0;
  let lateMinutes = 0;
  let lateMax = 0;
  let lateExcused = 0;
  const lateByDate = new Map();
  hadirDates.forEach((d) => {
    const first = byDate.get(d).find((r) => r.check_in_time);
    const late = num(first.late_min);
    if (late <= 0) return;
    if (leaveByDate.get(d)?.duration === "half_day_morning") {
      lateExcused += 1;
      return;
    }
    lateCount += 1;
    lateMinutes += late;
    lateMax = Math.max(lateMax, late);
    lateByDate.set(d, late);
  });

  // Pulang cepat — check-out terakhir per tanggal (Frontliner, sebelum jam selesai shift).
  // Dikecualikan bila izin ½ hari siang disetujui.
  let earlyCount = 0;
  let earlyMinutes = 0;
  let earlyExcused = 0;
  const earlyByDate = new Map();
  hadirDates.forEach((d) => {
    const recs = byDate.get(d).filter((r) => r.check_out_time);
    const last = recs[recs.length - 1];
    const early = num(last?.early_min);
    if (early <= 0) return;
    if (leaveByDate.get(d)?.duration === "half_day_afternoon") {
      earlyExcused += 1;
      return;
    }
    earlyCount += 1;
    earlyMinutes += early;
    earlyByDate.set(d, early);
  });

  // Kasbon & pinjaman
  const loanRows = (ctx.kasbon.get(id) || []).map((k) => {
    const isApproved = k.status === "disetujui";
    const approved = isApproved ? num(k.amount_approved ?? k.amount_requested) : 0;
    const kMethod = k.payment_method || "potong_gaji";
    const pays = (ctx.payments.get(Number(k.id)) || []).map((p) => {
      const due = toISODate(p.due_date) || toISODate(p.payment_date);
      return {
        id: p.id,
        installment_no: p.installment_no,
        due_date: due,
        amount: num(p.amount),
        method: p.payment_method || kMethod,
        status: p.status,
        paid_at: p.paid_at || null,
        recorded_by_name: p.recorded_by_name || null,
        notes: p.notes || null,
        in_period: Boolean(due && due >= startDate && due <= endDate),
        arrears: p.status !== "terbayar" && Boolean(due && due < startDate),
      };
    });
    // Data lama: disetujui tapi belum punya jadwal termin → dibebankan ke periode ini
    const legacy = isApproved && pays.length === 0;
    const legacyCharge = !legacy ? 0
      : k.type === "pinjaman"
        ? num(k.installment_amount) || Math.floor(approved / Math.max(1, num(k.tenor_count) || 1))
        : approved;
    const legacyDirect = kMethod === "langsung";
    const amountOf = (list, direct) => list
      .filter((p) => (p.method === "langsung") === direct)
      .reduce((s, p) => s + p.amount, 0);
    const current = pays.filter((p) => p.in_period);
    const arrears = pays.filter((p) => p.arrears);
    const deductionCurrent = amountOf(current, false) + (legacy && !legacyDirect ? legacyCharge : 0);
    const deductionArrears = amountOf(arrears, false);
    return {
      id: k.id,
      type: k.type,
      submission_date: toISODate(k.submission_date),
      amount_requested: num(k.amount_requested),
      amount_approved: approved,
      payment_method: k.payment_method || null,
      tenor_count: num(k.tenor_count) || 1,
      installment_amount: num(k.installment_amount),
      is_opening_balance: Number(k.is_opening_balance) === 1,
      purpose: k.purpose || null,
      notes: k.notes || null,
      status: k.status,
      approved_by_name: k.approved_by_name || null,
      approved_note: k.approved_note || null,
      rejection_note: k.rejection_note || null,
      legacy,
      total_paid: pays.filter((p) => p.status === "terbayar").reduce((s, p) => s + p.amount, 0),
      remaining: !isApproved ? 0
        : legacy ? approved
          : pays.filter((p) => p.status !== "terbayar").reduce((s, p) => s + p.amount, 0),
      // Potongan gaji periode ini = termin periode + tunggakan (metode potong_gaji)
      deduction: deductionCurrent + deductionArrears,
      deduction_current: deductionCurrent,
      deduction_arrears: deductionArrears,
      // Kewajiban periode ini yang dibayar langsung oleh karyawan (tidak memotong gaji)
      direct: amountOf([...current, ...arrears], true) + (legacy && legacyDirect ? legacyCharge : 0),
      deduction_installments: [...arrears, ...current].map((p) => p.installment_no),
      submitted_in_period: toISODate(k.submission_date) >= startDate && toISODate(k.submission_date) <= endDate,
      payments: pays,
    };
  });
  const kasbonList = loanRows.filter((k) => k.type === "kasbon");
  const pinjamanList = loanRows.filter((k) => k.type === "pinjaman");
  const total = (list, key) => list.reduce((s, k) => s + k[key], 0);
  const isWaiting = (k) => k.status === "pengajuan" || k.status === "proses";
  const kasbonSum = {
    count: kasbonList.filter((k) => k.submitted_in_period && k.status !== "ditolak").length,
    approved_amount: total(kasbonList.filter((k) => k.submitted_in_period), "amount_approved"),
    deduction: total(kasbonList, "deduction"),
    arrears: total(kasbonList, "deduction_arrears"),
    direct: total(kasbonList, "direct"),
    outstanding: total(kasbonList, "remaining"),
    pending: kasbonList.filter(isWaiting).length,
    pending_amount: total(kasbonList.filter(isWaiting), "amount_requested"),
  };
  const activeLoans = pinjamanList.filter((k) => k.status === "disetujui" && (k.remaining > 0 || k.deduction > 0 || k.direct > 0));
  const pinjamanSum = {
    active: activeLoans.length,
    outstanding: total(activeLoans, "remaining"),
    deduction: total(pinjamanList, "deduction"),
    arrears: total(pinjamanList, "deduction_arrears"),
    direct: total(pinjamanList, "direct"),
    new_count: pinjamanList.filter((k) => k.submitted_in_period && k.status === "disetujui").length,
    pending: pinjamanList.filter(isWaiting).length,
    pending_amount: total(pinjamanList.filter(isWaiting), "amount_requested"),
  };

  // Hari tanpa keterangan: sejak tanggal masuk s/d kemarin (atau tanggal keluar)
  const yesterday = shiftISO(today, -1);
  const scopeFrom = emp.join_date && emp.join_date > startDate ? emp.join_date : startDate;
  const scopeTo = [endDate, yesterday, emp.exit_date].filter(Boolean).sort()[0];
  // Daily Worker datang hanya saat dibutuhkan → hari tanpa absen bukan "tanpa keterangan"
  const isDaily = roleRow?.role === DAILY_WORKER_ROLE;
  const workNotas = isDaily ? ctx.work.notas.get(id) || [] : [];
  const workQc = isDaily ? ctx.work.qc.get(id) || [] : [];
  const noInfoDates = !isDaily && scopeFrom <= scopeTo
    ? eachDate(scopeFrom, scopeTo).filter((d) => !hadirDates.has(d) && !offDates.has(d) && !leaveByDate.has(d))
    : [];

  const locationsList = [...placeCount].map(([pid, count]) => {
    const p = placeOf(ctx, pid);
    return { ...p, count, is_home: pid === homeOutletId };
  }).sort((a, b) => b.count - a.count);

  const summary = {
    employee_id: id,
    employee_code: emp.employee_code,
    employee_name: emp.employee_name,
    join_date: emp.join_date,
    exit_date: emp.exit_date,
    role: roleRow?.role || null,
    is_daily_worker: isDaily,
    work: isDaily ? summarizeWork(workNotas, workQc) : null,
    is_leader: Number(roleRow?.is_leader) === 1,
    home_outlet: home,
    hadir: hadirDates.size,
    off: offApproved.length,
    off_pending: offPending.length,
    work_minutes: workMinutes,
    avg_work_minutes: workedDates.size ? Math.round(workMinutes / workedDates.size) : 0,
    incomplete_checkout: incomplete,
    locations: locationsList,
    outside_home: outsideHome,
    backup: backups.length,
    overtime: {
      approved_count: otApproved.length,
      approved_minutes: otMinutes,
      pending_count: ot.filter((r) => r.status === "pengajuan" || r.status === "berlangsung").length,
      rejected_count: ot.filter((r) => r.status === "ditolak").length,
    },
    leave: {
      ...leaveDays,
      total_days: leaveDays.izin + leaveDays.sakit + leaveDays.cuti,
      pending: leaves.filter((l) => l.status === "pengajuan").length,
      rejected: leaves.filter((l) => l.status === "ditolak").length,
    },
    late: { count: lateCount, minutes: lateMinutes, max: lateMax, excused: lateExcused },
    early: { count: earlyCount, minutes: earlyMinutes, excused: earlyExcused },
    kasbon: kasbonSum,
    pinjaman: pinjamanSum,
    no_info_days: noInfoDates.length,
    deduction_total: kasbonSum.deduction + pinjamanSum.deduction,
    direct_total: kasbonSum.direct + pinjamanSum.direct,
  };
  if (!withDetail) return summary;

  // ── Detail: kalender harian + daftar per kategori ──
  const noInfoSet = new Set(noInfoDates);
  const countByDate = (list) => list.reduce((m, r) => m.set(r.date, (m.get(r.date) || 0) + 1), new Map());
  const notaByDate = countByDate(workNotas);
  const qcByDate = countByDate(workQc);
  const days = eachDate(startDate, endDate).map((d) => {
    const recs = (byDate.get(d) || []).filter((r) => r.check_in_time);
    const first = recs[0] || null;
    const last = recs[recs.length - 1] || null;
    const leave = leaveByDate.get(d) || null;
    let status;
    if (recs.length) status = "hadir";
    else if (leave) status = leave.type;
    else if (offDates.has(d)) status = "off";
    else if (noInfoSet.has(d)) status = "tanpa_keterangan";
    else if (emp.join_date && d < emp.join_date) status = "belum_bergabung";
    else if (emp.exit_date && d > emp.exit_date) status = "sudah_keluar";
    else if (isDaily && d <= yesterday) status = "tidak_bekerja";
    else status = "belum_berjalan";
    return {
      date: d,
      status,
      half_day_leave: leave?.half && recs.length ? leave.type : null,
      off_but_present: recs.length > 0 && offDates.has(d),
      check_in: hhmm(first?.check_in_time),
      check_out: hhmm(last?.check_out_time),
      work_minutes: recs.reduce((s, r) => s + num(r.work_min), 0),
      no_checkout: recs.some((r) => !r.check_out_time),
      late_minutes: lateByDate.get(d) || 0,
      late_excused: Boolean(first && leave?.duration === "half_day_morning" && num(first.late_min) > 0),
      early_minutes: earlyByDate.get(d) || 0,
      shift_name: first?.shift_name || null,
      shift_assumed: Boolean(first?.shift_assumed),
      location: first ? placeOf(ctx, first.outlet_id) : null,
      outside_home: Boolean(first && homeOutletId && Number(first.outlet_id) !== homeOutletId),
      overtime_minutes: otByDate.get(d) || 0,
      backup_for: backupByDate.get(d) || [],
      nota_count: notaByDate.get(d) || 0,
      qc_count: qcByDate.get(d) || 0,
      note: [first?.check_in_note, last?.check_out_note].filter(Boolean).join(" · ") || null,
    };
  });

  return {
    ...summary,
    days,
    overtime_list: ot.map((r) => ({
      id: r.id,
      date: toISODate(r.overtime_date),
      start: r.start_at ? hhmm(r.start_at) : String(r.start_time || "").slice(0, 5) || null,
      end: r.end_at ? hhmm(r.end_at) : (r.status === "berlangsung" ? null : String(r.end_time || "").slice(0, 5) || null),
      minutes: r.minutes,
      location: r.outlet_id ? placeOf(ctx, r.outlet_id) : null,
      reason: r.reason || null,
      work_note: r.work_note || null,
      status: r.status,
      reviewed_by_name: r.reviewed_by_name || null,
      review_note: r.approval_note || r.rejection_note || null,
    })),
    leave_list: leaves.map((l) => ({
      id: l.leave_id,
      type: l.leave_type,
      duration_type: l.duration_type,
      start_date: toISODate(l.start_date),
      end_date: toISODate(l.end_date),
      days_in_period: l.days_in_period,
      reason: l.reason || null,
      status: l.status,
      rejection_note: l.rejection_note || null,
    })),
    off_list: offsOwn.map((d) => ({
      id: d.day_off_id,
      date: toISODate(d.off_date),
      status: d.status,
      reason: d.reason || null,
      backup_name: d.backup_employee_id ? ctx.nameMap.get(Number(d.backup_employee_id))?.full_name || `#${d.backup_employee_id}` : null,
    })),
    backup_list: backups.map((b) => ({
      id: b.day_off_id,
      date: toISODate(b.off_date),
      replaced_name: ctx.nameMap.get(Number(b.employee_id))?.full_name || `#${b.employee_id}`,
      reason: b.reason || null,
    })),
    kasbon_list: kasbonList,
    pinjaman_list: pinjamanList,
    work_notas: workNotas,
    work_qc: workQc,
  };
}

async function buildPayroll(query, { employeeId = null, withDetail = false } = {}) {
  const { startDate, endDate } = resolvePeriod(query);
  const employees = await loadEmployees({
    startDate,
    endDate,
    outletId: query.outletId || null,
    role: query.role || "",
    employeeId,
    search: employeeId ? "" : query.search,
  });
  if (!employees.length) return { startDate, endDate, data: [] };
  const ctx = await loadActivity(employees.map((e) => e.employee_id), startDate, endDate);
  const data = employees.map((e) => buildEmployee(e, ctx, startDate, endDate, withDetail));
  return { startDate, endDate, data };
}

function totalsOf(rows) {
  return rows.reduce((t, r) => ({
    employees: t.employees + 1,
    hadir: t.hadir + r.hadir,
    off: t.off + r.off,
    work_minutes: t.work_minutes + r.work_minutes,
    backup: t.backup + r.backup,
    overtime_minutes: t.overtime_minutes + r.overtime.approved_minutes,
    overtime_count: t.overtime_count + r.overtime.approved_count,
    leave_days: t.leave_days + r.leave.total_days,
    late_count: t.late_count + r.late.count,
    no_info_days: t.no_info_days + r.no_info_days,
    kasbon_deduction: t.kasbon_deduction + r.kasbon.deduction,
    pinjaman_deduction: t.pinjaman_deduction + r.pinjaman.deduction,
    pinjaman_outstanding: t.pinjaman_outstanding + r.pinjaman.outstanding,
    direct_total: t.direct_total + r.direct_total,
  }), {
    employees: 0, hadir: 0, off: 0, work_minutes: 0, backup: 0, overtime_minutes: 0, overtime_count: 0,
    leave_days: 0, late_count: 0, no_info_days: 0, kasbon_deduction: 0, pinjaman_deduction: 0, pinjaman_outstanding: 0,
    direct_total: 0,
  });
}

const fail = (res, label, err) => {
  console.error(`[${label}]`, err);
  return res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : "Gagal memuat data payroll" });
};

// GET /waschen/hris/payroll — rekap semua karyawan
// Query: startDate, endDate, outletId, role, search
export const getPayrollList = async (req, res) => {
  try {
    const { startDate, endDate, data } = await buildPayroll(req.query);
    return res.json({ success: true, period: { startDate, endDate }, totals: totalsOf(data), data });
  } catch (err) {
    return fail(res, "getPayrollList", err);
  }
};

// GET /waschen/hris/payroll/details — detail lengkap semua karyawan (untuk export semua)
export const getPayrollDetailsAll = async (req, res) => {
  try {
    const { startDate, endDate, data } = await buildPayroll(req.query, { withDetail: true });
    return res.json({ success: true, period: { startDate, endDate }, totals: totalsOf(data), data });
  } catch (err) {
    return fail(res, "getPayrollDetailsAll", err);
  }
};

// GET /waschen/hris/payroll/:employeeId — detail satu karyawan
export const getPayrollDetail = async (req, res) => {
  try {
    const employeeId = Number(req.params.employeeId);
    if (!employeeId) return res.status(400).json({ success: false, message: "Karyawan tidak valid" });
    const { startDate, endDate, data } = await buildPayroll(req.query, { employeeId, withDetail: true });
    if (!data.length) return res.status(404).json({ success: false, message: "Karyawan tidak ditemukan" });
    return res.json({ success: true, period: { startDate, endDate }, data: data[0] });
  } catch (err) {
    return fail(res, "getPayrollDetail", err);
  }
};
