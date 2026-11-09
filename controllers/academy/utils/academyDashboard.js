const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const ratio = (count, total) => ({ count, percent: total ? Math.round((count / total) * 100) : null });
const present = (values) => values.filter((v) => v !== null && v !== undefined).map(Number);

/**
 * Angka dashboard training. Pembagi kehadiran dan kelulusan = semua peserta termasuk yang tidak hadir,
 * sesuai contoh PDF (38 dari 48). Lulus dengan perbaikan dihitung lulus.
 */
export function summarizeTraining(participants) {
  const total = participants.length;
  const gains = participants
    .filter((p) => p.pre_score !== null && p.post_score !== null)
    .map((p) => Number(p.post_score) - Number(p.pre_score));
  const gain = mean(gains);
  const mentor = mean(present(participants.map((p) => p.mentor_score)));
  const feedback = mean(present(participants.map((p) => p.feedback_score)));

  return {
    batch_count: new Set(participants.map((p) => p.batch_id)).size,
    participant_count: total,
    attendance: ratio(participants.filter((p) => p.status !== "ABSENT").length, total),
    passed: ratio(participants.filter((p) => ["LULUS", "LULUS_PERBAIKAN"].includes(p.result_status)).length, total),
    average_gain: gain === null ? null : Math.round(gain),
    average_mentor: mentor === null ? null : round1(mentor),
    average_feedback: feedback === null ? null : round1(feedback),
  };
}

/** Skill gap: rata-rata satu indikator dari semua karyawan. Di bawah 3 = gap. Urut dari yang terendah. */
export function indicatorAverages(details) {
  const byIndicator = new Map();
  for (const d of details) {
    if (!byIndicator.has(d.indicator_id)) byIndicator.set(d.indicator_id, { name: d.indicator_name, scores: [] });
    byIndicator.get(d.indicator_id).scores.push(Number(d.score));
  }
  return [...byIndicator]
    .map(([indicator_id, { name, scores }]) => {
      const average = round1(mean(scores));
      return { indicator_id, name, average, gap: average < 3 };
    })
    .sort((a, b) => a.average - b.average);
}
