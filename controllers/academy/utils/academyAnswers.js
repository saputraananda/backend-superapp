import { questionMaxPoints } from "./academyScoring.js";

/**
 * Jawaban satu fase untuk dilihat HR. questions = soal fase itu, berurutan, tiap soal membawa
 * options [{ id, option_text, is_correct }] dan answer_guide. answerRows = baris tr_test_answer
 * digabung opsi terpilih: { question_id, answer_text, is_correct, option_id }.
 * Soal tanpa jawaban dilewati, tetapi nomornya tetap dihitung agar sama dengan rapor peserta.
 * is_correct hasil = poin yang didapat (null = essay belum dinilai).
 */
export function buildParticipantAnswers(questions, answerRows) {
  return questions
    .map((q, index) => {
      const rows = answerRows.filter((r) => r.question_id === q.id);
      if (!rows.length) return null;
      const isEssay = q.type === "ESSAY";
      const picked = new Set(rows.map((r) => r.option_id).filter((id) => id != null));
      return {
        id: q.id,
        number: index + 1,
        topic_name: q.topic_name,
        type: q.type,
        question_text: q.question_text,
        options: isEssay
          ? []
          : q.options.map((o) => ({ id: o.id, option_text: o.option_text, is_correct: Boolean(o.is_correct), selected: picked.has(o.id) })),
        answer_text: isEssay ? rows[0].answer_text ?? "" : null,
        answer_guide: isEssay ? q.answer_guide ?? null : null,
        is_correct: rows[0].is_correct,
        max_points: questionMaxPoints(q.type, q.options.filter((o) => o.is_correct).length),
      };
    })
    .filter(Boolean);
}
