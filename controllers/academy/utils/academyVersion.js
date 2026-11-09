const PHASES = ["PRE", "POST"];
const QUESTION_TYPES = ["SINGLE", "MULTI", "ESSAY"];
const FEEDBACK_TYPES = ["SCALE", "OPEN"];
const INDICATOR_CATEGORIES = ["PRAKTIK", "SIKAP"];

const isBlank = (value) => !String(value ?? "").trim();
const isFilled = (value) => value !== "" && value !== null && value !== undefined;
const isScore = (value) => isFilled(value) && Number(value) >= 0 && Number(value) <= 100;
const isWeight = (value) => isFilled(value) && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 100;

/** Mengembalikan pesan error, atau null kalau valid. topicIds = topik milik training ini. */
export function validateTrainingContent(content, topicIds) {
  const {
    pass_score,
    pass_with_fix_score,
    practice_weight,
    attitude_weight,
    questions = [],
    feedback_questions = [],
    indicators = [],
  } = content;
  const validTopic = (id) => topicIds.includes(Number(id));

  if (!isScore(pass_score) || !isScore(pass_with_fix_score)) {
    return "Standar kelulusan harus berupa angka 0 sampai 100";
  }
  if (Number(pass_score) <= Number(pass_with_fix_score)) {
    return "Batas Lulus harus lebih tinggi dari batas Lulus dengan perbaikan";
  }
  if (!isWeight(practice_weight) || !isWeight(attitude_weight) || Number(practice_weight) + Number(attitude_weight) !== 100) {
    return "Bobot Praktik dan Sikap harus berupa bilangan bulat dan berjumlah 100";
  }

  for (const [index, q] of questions.entries()) {
    const label = `Soal ${index + 1}`;
    const type = q.type ?? "SINGLE";
    if (!PHASES.includes(q.phase)) return `${label}: jenis test tidak dikenal`;
    if (!QUESTION_TYPES.includes(type)) return `${label}: tipe soal tidak dikenal`;
    if (!validTopic(q.topic_id)) return `${label}: topik tidak valid`;
    if (isBlank(q.question_text)) return `${label}: teks soal wajib diisi`;
    if (type === "ESSAY") continue;

    const options = q.options ?? [];
    if (options.length < 2) return `${label}: minimal dua opsi jawaban`;
    if (options.some((o) => isBlank(o.option_text))) return `${label}: teks opsi wajib diisi`;
    const correct = options.filter((o) => o.is_correct).length;
    if (type === "SINGLE" && correct !== 1) return `${label}: wajib punya tepat satu kunci jawaban`;
    if (type === "MULTI" && correct < 1) return `${label}: wajib punya minimal satu kunci jawaban`;
  }

  for (const [index, f] of feedback_questions.entries()) {
    const label = `Pertanyaan feedback ${index + 1}`;
    if (!FEEDBACK_TYPES.includes(f.type)) return `${label}: tipe tidak dikenal`;
    if (isBlank(f.question_text)) return `${label}: teks wajib diisi`;
  }

  for (const [index, i] of indicators.entries()) {
    const label = `Indikator mentor ${index + 1}`;
    if (!INDICATOR_CATEGORIES.includes(i.category)) return `${label}: kategori tidak dikenal`;
    // Sikap berlaku untuk semua peserta, jadi tidak terikat topik.
    if (i.category === "PRAKTIK" && !validTopic(i.topic_id)) return `${label}: topik tidak valid`;
    if (isBlank(i.indicator_text)) return `${label}: teks wajib diisi`;
  }

  return null;
}

async function writeVersionChildren(conn, versionId, content, userId) {
  const { questions = [], feedback_questions = [], indicators = [] } = content;

  for (const [order, q] of questions.entries()) {
    const type = q.type ?? "SINGLE";
    const [inserted] = await conn.query(
      `INSERT INTO mst_question (version_id, topic_id, phase, type, question_text, answer_guide, keywords, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        versionId,
        q.topic_id,
        q.phase,
        type,
        q.question_text,
        String(q.answer_guide ?? "").trim() || null,
        String(q.keywords ?? "").trim() || null,
        order,
        userId,
      ]
    );
    if (type === "ESSAY") continue;

    for (const [optionOrder, o] of q.options.entries()) {
      await conn.query(
        `INSERT INTO mst_question_option (question_id, option_text, is_correct, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?)`,
        [inserted.insertId, o.option_text, o.is_correct ? 1 : 0, optionOrder, userId]
      );
    }
  }

  for (const [order, f] of feedback_questions.entries()) {
    await conn.query(
      `INSERT INTO mst_feedback_question (version_id, type, question_text, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [versionId, f.type, f.question_text, order, userId]
    );
  }

  for (const [order, i] of indicators.entries()) {
    await conn.query(
      `INSERT INTO mst_mentor_indicator (version_id, category, topic_id, indicator_text, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [versionId, i.category, i.category === "SIKAP" ? null : i.topic_id, i.indicator_text, order, userId]
    );
  }
}

/**
 * Menyimpan seluruh isi training. Wajib dipanggil di dalam transaksi.
 * Versi yang sudah dipakai batch tidak disentuh, isinya ditulis sebagai versi baru,
 * supaya batch lama dan rapornya tetap memakai soal dan standar lamanya.
 */
export async function saveVersionContent(conn, trainingId, content, userId) {
  // Baris training dikunci supaya batch baru tidak bisa memakai versi ini saat sedang ditimpa.
  const [trainings] = await conn.query(`SELECT id FROM mst_training WHERE id = ? FOR UPDATE`, [trainingId]);
  if (!trainings.length) return { notFound: true };

  const [topics] = await conn.query(`SELECT id FROM mst_training_topic WHERE training_id = ?`, [trainingId]);
  const error = validateTrainingContent(content, topics.map((t) => t.id));
  if (error) return { error };

  const [[latest]] = await conn.query(
    `SELECT id, version_no FROM mst_training_version WHERE training_id = ? ORDER BY version_no DESC LIMIT 1`,
    [trainingId]
  );
  const [[usage]] = await conn.query(`SELECT COUNT(*) AS n FROM tr_training_batch WHERE version_id = ?`, [latest.id]);
  const { pass_score, pass_with_fix_score, practice_weight, attitude_weight } = content;

  if (usage.n > 0) {
    const versionNo = latest.version_no + 1;
    const [inserted] = await conn.query(
      `INSERT INTO mst_training_version (training_id, version_no, pass_score, pass_with_fix_score, practice_weight, attitude_weight, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [trainingId, versionNo, pass_score, pass_with_fix_score, practice_weight, attitude_weight, userId]
    );
    await writeVersionChildren(conn, inserted.insertId, content, userId);
    return { versionId: inserted.insertId, versionNo, isNewVersion: true };
  }

  await conn.query(
    `UPDATE mst_training_version SET pass_score = ?, pass_with_fix_score = ?, practice_weight = ?, attitude_weight = ? WHERE id = ?`,
    [pass_score, pass_with_fix_score, practice_weight, attitude_weight, latest.id]
  );
  await conn.query(
    `DELETE o FROM mst_question_option o JOIN mst_question q ON q.id = o.question_id WHERE q.version_id = ?`,
    [latest.id]
  );
  await conn.query(`DELETE FROM mst_question WHERE version_id = ?`, [latest.id]);
  await conn.query(`DELETE FROM mst_feedback_question WHERE version_id = ?`, [latest.id]);
  await conn.query(`DELETE FROM mst_mentor_indicator WHERE version_id = ?`, [latest.id]);
  await writeVersionChildren(conn, latest.id, content, userId);
  return { versionId: latest.id, versionNo: latest.version_no, isNewVersion: false };
}
