// Aturan jam masuk/pulang Waschen. Sama dengan waschen-mobile/api/controllers/attendance.
//   Frontliner : batas telat = open_time shift (mst_time_shift), pulang cepat = close_time.
//                shift_code kosong = 'pagi'.
//   Role lain  : batas telat 08:00, tanpa cek pulang cepat.
import { safeMyWaschenQuery } from "../../../db/pool.js";

export const SHIFT_ROLE = "Frontliner";
export const DEFAULT_SHIFT_CODE = "pagi";
const DEFAULT_LATE_AFTER = 8 * 60;
const FALLBACK_SHIFTS = [
  { code: "pagi", name: "Shift Pagi", open_time: "08:00:00", close_time: "17:00:00" },
  { code: "siang", name: "Shift Siang", open_time: "10:30:00", close_time: "20:00:00" },
];

export const requiresShift = (role) => String(role || "").trim() === SHIFT_ROLE;

const timeToMin = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

// "YYYY-MM-DD HH:mm:ss" (dateStrings, WIB) atau Date → menit dari 00:00.
export function clockMinutes(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const m = v.match(/(?:T|\s)(\d{1,2}):(\d{2})/);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
}

/** Map code → { code, name, openMin, closeMin } dari mst_time_shift (aktif). */
export async function loadShiftMap() {
  let rows = FALLBACK_SHIFTS;
  try {
    const [r] = await safeMyWaschenQuery(
      `SELECT code, name, open_time, close_time FROM mst_time_shift WHERE is_active = 1 ORDER BY sort_order ASC, shift_number ASC`,
    );
    if (r.length) rows = r;
  } catch (_) { /* tabel opsional */ }
  return new Map(rows.map((s) => [s.code, {
    code: s.code,
    name: s.name,
    openMin: timeToMin(s.open_time),
    closeMin: timeToMin(s.close_time),
  }]));
}

/**
 * Telat & pulang cepat untuk satu absensi.
 * @returns {{ shift_code, shift_name, late_after_min, late_min, early_before_min, early_min }}
 */
export function evaluateShift(row, role, shiftMap) {
  const inMin = clockMinutes(row.check_in_time);
  const outMin = clockMinutes(row.check_out_time);
  let shift = null;
  if (requiresShift(role)) {
    shift = shiftMap.get(row.shift_code || DEFAULT_SHIFT_CODE) || shiftMap.get(DEFAULT_SHIFT_CODE) || null;
  }
  const lateAfter = shift?.openMin ?? DEFAULT_LATE_AFTER;
  const earlyBefore = shift?.closeMin ?? null;
  // Pulang lewat tengah malam (jam < batas masuk) bukan pulang cepat.
  const early = earlyBefore != null && outMin != null && outMin < earlyBefore && outMin >= lateAfter
    ? earlyBefore - outMin : 0;
  return {
    shift_code: shift ? shift.code : null,
    shift_name: shift ? shift.name : null,
    shift_assumed: Boolean(shift && !row.shift_code),
    late_after_min: lateAfter,
    late_min: inMin != null && inMin > lateAfter ? inMin - lateAfter : 0,
    early_before_min: earlyBefore,
    early_min: early,
  };
}
