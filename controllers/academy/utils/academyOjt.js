// Aturan OJT Alora Academy. Salinan dari waschen-mobile/api/utils/academyOjt.js (di sana tanpa validateOjtPayload):
// kalau aturan berubah, ubah keduanya bersamaan.
import { averageScore } from "./academyScoring.js";

export const MIN_OJT_DAYS = 2;
export const MAX_OJT_DAYS = 60;
export const MIN_SCORE = 1;
export const MAX_SCORE = 4;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Tanggal kalender yang nyata (2026-02-30 ditolak), format YYYY-MM-DD. */
export function isValidDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Dihitung dengan UTC supaya zona waktu server tidak menggeser tanggal.
export function addDays(value, n) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Semua tanggal periode OJT: tanggal mulai sebanyak `days` hari berturut-turut. */
export function dateRange(start, days) {
  return Array.from({ length: days }, (_, i) => addDays(start, i));
}

/** Hanya hari pertama dan hari terakhir OJT yang dinilai, untuk melihat kemajuan. */
export const scorableDates = (start, days) => [start, addDays(start, days - 1)];

/** NAIK, TURUN, atau TETAP dari nilai hari pertama ke hari terakhir. null kalau salah satunya belum dinilai. */
export function scoreProgress(first, last) {
  if (first === null || first === undefined || last === null || last === undefined) return null;
  if (last > first) return "NAIK";
  return last < first ? "TURUN" : "TETAP";
}

/**
 * Kemajuan per sub-skill, dikelompokkan per kriteria. subskills = baris tr_ojt_subskill OJT itu (urut kriteria lalu nama),
 * scoreRows = baris tr_ojt_score ({ score_date, ojt_subskill_id, score }). Nilai di tanggal selain hari pertama dan terakhir diabaikan.
 * Hasil: [{ id, name, subskills: [{ id, name, first_score, last_score, progress }] }].
 */
export function buildSubskillProgress(subskills, scoreRows, firstDate, lastDate) {
  const scoreOf = (subskillId, date) => scoreRows.find((r) => r.ojt_subskill_id === subskillId && r.score_date === date)?.score ?? null;
  const byCriterion = new Map();
  for (const s of subskills) {
    if (!byCriterion.has(s.criterion_id)) byCriterion.set(s.criterion_id, { id: s.criterion_id, name: s.criterion_name, subskills: [] });
    const first = scoreOf(s.id, firstDate);
    const last = scoreOf(s.id, lastDate);
    byCriterion.get(s.criterion_id).subskills.push({ id: s.id, name: s.name, first_score: first, last_score: last, progress: scoreProgress(first, last) });
  }
  return [...byCriterion.values()];
}

/** BELUM_MULAI, BERJALAN, atau SELESAI. Tanggal berbentuk YYYY-MM-DD, jadi bisa dibandingkan sebagai teks. */
export function ojtPhase(start, end, today) {
  if (today < start) return "BELUM_MULAI";
  return today > end ? "SELESAI" : "BERJALAN";
}

/** Nilai satu hari: rata-rata nilai sub-skill satu kriteria pada hari itu. */
export const dayAverage = (scores) => averageScore(scores);

/** Nilai OJT satu kriteria: rata-rata nilai harian. Hari yang belum dinilai (null) tidak ikut dihitung. */
export const ojtAverage = (dayAverages) => averageScore(dayAverages.filter((a) => a !== null && a !== undefined));

/**
 * Ringkasan satu kriteria: jumlah hari yang sudah dinilai (maksimal 2), nilai OJT kriteria itu, dan kemajuannya.
 * subskillIds = id tr_ojt_subskill milik kriteria itu; scoreRows = baris tr_ojt_score ({ score_date, ojt_subskill_id, score }).
 */
export function summarizeCriterion(subskillIds, scoreRows, firstDate, lastDate) {
  const mine = scoreRows.filter((r) => subskillIds.includes(r.ojt_subskill_id));
  const averages = [firstDate, lastDate].map((date) => {
    const rows = mine.filter((r) => r.score_date === date);
    return rows.length ? dayAverage(rows.map((r) => r.score)) : null;
  });
  return {
    scored_days: averages.filter((a) => a !== null).length,
    average: ojtAverage(averages),
    progress: scoreProgress(averages[0], averages[1]),
  };
}

/** Nilai satu hari harus mencakup persis semua sub-skill OJT, masing-masing bilangan bulat 1 sampai 4. */
export function validateDayScores(subskillIds, scores) {
  const submitted = new Map((Array.isArray(scores) ? scores : []).map((s) => [Number(s.subskill_id), Number(s.score)]));
  if (submitted.size !== subskillIds.length || subskillIds.some((id) => !submitted.has(id))) {
    return "Semua sub-skill wajib dinilai";
  }
  for (const score of submitted.values()) {
    if (!Number.isInteger(score) || score < MIN_SCORE || score > MAX_SCORE) return "Nilai harus 1 sampai 4";
  }
  return null;
}

const uniqueIntegers = (list) =>
  Array.isArray(list) && list.length > 0 && list.every(Number.isInteger) && new Set(list).size === list.length;

/** Urutan baru sub-skill satu kriteria harus memuat persis semua id kriteria itu, tanpa ganda. Mengembalikan pesan error, atau null. */
export function validateSubskillOrder(currentIds, submittedIds) {
  const same =
    Array.isArray(submittedIds) &&
    submittedIds.every(Number.isInteger) &&
    new Set(submittedIds).size === submittedIds.length &&
    submittedIds.length === currentIds.length &&
    currentIds.every((id) => submittedIds.includes(id));
  return same ? null : "Urutan sub-skill tidak valid";
}

/** Data OJT dari HR. Mengembalikan pesan error, atau null kalau valid. */
export function validateOjtPayload(body) {
  if (!Number.isInteger(body.participant_id)) return "Peserta wajib dipilih";
  if (!isValidDate(body.start_date)) return "Tanggal mulai tidak valid";
  if (!Number.isInteger(body.days) || body.days < MIN_OJT_DAYS || body.days > MAX_OJT_DAYS) {
    return `Jumlah hari harus ${MIN_OJT_DAYS} sampai ${MAX_OJT_DAYS}`;
  }
  if (!uniqueIntegers(body.observer_ids)) return "Pemantau wajib dipilih, tanpa duplikat";
  if (!uniqueIntegers(body.criterion_ids)) return "Kriteria penilaian wajib dipilih, tanpa duplikat";
  return null;
}
