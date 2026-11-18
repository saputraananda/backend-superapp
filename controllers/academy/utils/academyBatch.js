const SOURCES = ["REQUEST", "SKILL_MATRIX", "ROUTINE"];
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/** "2026-11-10T08:00" dari datetime-local menjadi format DATETIME MySQL. */
export const toMysqlDatetime = (value) => {
  const text = String(value).replace("T", " ");
  return text.length === 16 ? `${text}:00` : text;
};

/**
 * Mengembalikan pesan error, atau null kalau valid.
 * topics = id topik aktif training itu: active (semua), pre / post (punya soal PRE / POST di versi terbaru),
 * practice (punya indikator Praktik). Topik boleh tanpa soal atau indikator, tetapi gabungan topik tiap peserta
 * butuh minimal satu soal Pre, satu soal Post, dan satu indikator Praktik, supaya tes dan nilai mentor bisa jalan.
 */
export function validateBatchPayload(body, topics) {
  const { source, start_at, request_id, sm_position_id, mentors = [], participants = [] } = body;

  if (!SOURCES.includes(source)) return "Sumber training tidak dikenal";
  if (source === "REQUEST" && !request_id) return "Pilih pengajuan training";
  if (source === "SKILL_MATRIX" && !sm_position_id) return "Pilih posisi skill matrix";
  if (!DATETIME.test(String(start_at ?? "")) || Number.isNaN(Date.parse(String(start_at).replace(" ", "T")))) {
    return "Waktu mulai wajib diisi dengan tanggal dan jam yang valid";
  }

  for (const mentor of mentors) {
    if (!mentor.employee_id && !String(mentor.vendor_name ?? "").trim()) return "Mentor wajib dipilih atau diisi nama vendornya";
  }

  if (!participants.length) return "Minimal satu peserta";
  const seen = new Set();
  for (const participant of participants) {
    const id = Number(participant.employee_id);
    if (!id) return "Peserta tidak valid";
    if (seen.has(id)) return "Ada peserta yang dipilih dua kali";
    seen.add(id);

    const topicIds = participant.topic_ids ?? [];
    if (!topicIds.length) return "Tiap peserta wajib punya minimal satu topik";
    if (topicIds.some((t) => !topics.active.includes(Number(t)))) return "Ada topik yang tidak valid atau sudah nonaktif";
    const hasAny = (ids) => topicIds.some((t) => ids.includes(Number(t)));
    if (!hasAny(topics.pre)) return "Tiap peserta wajib punya minimal satu topik yang punya soal Pre-test";
    if (!hasAny(topics.post)) return "Tiap peserta wajib punya minimal satu topik yang punya soal Post-test";
    if (!hasAny(topics.practice)) return "Tiap peserta wajib punya minimal satu topik yang punya indikator Praktik";
  }

  return null;
}
