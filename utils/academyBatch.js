const SOURCES = ["REQUEST", "SKILL_MATRIX", "ROUTINE"];
const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/** "2026-11-10T08:00" dari datetime-local menjadi format DATETIME MySQL. */
export const toMysqlDatetime = (value) => {
  const text = String(value).replace("T", " ");
  return text.length === 16 ? `${text}:00` : text;
};

/**
 * Mengembalikan pesan error, atau null kalau valid.
 * readyTopicIds = topik aktif yang sudah punya soal PRE dan POST di versi terbaru.
 * practiceTopicIds = topik yang punya indikator Praktik. Tiap peserta butuh minimal satu, supaya nilai mentor bisa dihitung.
 */
export function validateBatchPayload(body, readyTopicIds, practiceTopicIds) {
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
    if (topicIds.some((t) => !readyTopicIds.includes(Number(t)))) {
      return "Ada topik yang soal Pre atau Post-nya belum lengkap";
    }
    if (!topicIds.some((t) => practiceTopicIds.includes(Number(t)))) {
      return "Tiap peserta wajib punya minimal satu topik yang punya indikator Praktik";
    }
  }

  return null;
}
