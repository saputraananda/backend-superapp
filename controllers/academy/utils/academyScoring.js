// Rumus Alora Academy. Salinan yang sama ada di waschen-mobile/api/utils/academyScoring.js:
// kalau rumus berubah, ubah keduanya bersamaan.

// EPSILON supaya 2,75 tidak terbaca 2,7499999 lalu turun.
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

/** Poin ÷ poin maksimum × 100, dibulatkan ke angka bulat. */
export function testScore(points, maxPoints) {
  return maxPoints ? round((points / maxPoints) * 100, 0) : null;
}

/** Poin maksimum satu soal: pilihan ganda 1, checkbox sebanyak kunci jawaban, essay 2. */
export function questionMaxPoints(type, correctCount) {
  if (type === "ESSAY") return 2;
  return type === "MULTI" ? correctCount : 1;
}

/**
 * Nilai test dari poin tiap soal. is_correct menyimpan poin yang didapat: pilihan ganda 0 atau 1,
 * checkbox jumlah kunci yang terpilih, essay 0, 1, atau 2 dari HR.
 * answers = [{ is_correct, max_points }]. null kalau ada soal yang belum dinilai (essay) atau tidak ada jawaban.
 */
export function testScoreFromAnswers(answers) {
  if (!answers.length || answers.some((a) => a.is_correct === null || a.is_correct === undefined)) return null;
  const points = answers.reduce((sum, a) => sum + Number(a.is_correct), 0);
  const maxPoints = answers.reduce((sum, a) => sum + a.max_points, 0);
  return testScore(points, maxPoints);
}

/** Rata-rata skala 1–4, dibulatkan 1 desimal. */
export function averageScore(scores) {
  return scores.length ? round(scores.reduce((sum, s) => sum + Number(s), 0) / scores.length, 1) : null;
}

/** Praktik × 60% + Sikap × 40%, dari nilai yang sudah dibulatkan, seperti contoh PDF. */
export function mentorScore(practice, attitude, practiceWeight = 60, attitudeWeight = 40) {
  return round((practice * practiceWeight) / 100 + (attitude * attitudeWeight) / 100, 1);
}

/** 50% post-test + 50% (mentor ÷ 4 × 100), dibulatkan ke angka bulat. */
export function finalScore(post, mentor) {
  return round(0.5 * post + 0.5 * ((mentor / 4) * 100), 0);
}

/** Standar kelulusan per versi ditentukan HR. */
export function resultStatus(final, passScore, passWithFixScore) {
  if (final >= Number(passScore)) return "LULUS";
  if (final >= Number(passWithFixScore)) return "LULUS_PERBAIKAN";
  return "TIDAK_LULUS";
}

/**
 * Menghitung semua nilai turunan peserta. Nilai akhir hanya terisi kalau post-test
 * dan nilai mentor sudah ada, jadi bisa dipanggil dari sisi mana pun yang terisi terakhir.
 */
export function computeParticipantScores({ postScore, practiceScores, attitudeScores, version }) {
  const practice = averageScore(practiceScores);
  const attitude = averageScore(attitudeScores);
  const mentor =
    practice === null || attitude === null
      ? null
      : mentorScore(practice, attitude, version.practice_weight, version.attitude_weight);
  const final = mentor === null || postScore === null || postScore === undefined ? null : finalScore(postScore, mentor);

  return {
    practice_score: practice,
    attitude_score: attitude,
    mentor_score: mentor,
    final_score: final,
    result_status: final === null ? null : resultStatus(final, version.pass_score, version.pass_with_fix_score),
  };
}
