import { academyPool, safeAcademyQuery, safeMyWaschenQuery, safeQuery } from "../../db/pool.js";
import { toMysqlDatetime, validateBatchPayload } from "./utils/academyBatch.js";
import { matchKeywords } from "./utils/academyEssay.js";
import { computeParticipantScores, questionMaxPoints, testScoreFromAnswers } from "./utils/academyScoring.js";

// Peserta Academy hanya karyawan Waschen (sama dengan WASCHEN_COMPANY_ID di waschen-mobile).
const WASCHEN_COMPANY_ID = 5;

const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
};

/** Karyawan Waschen aktif beserta cabangnya. Cabang ada di mst_role (DB my_waschen), bukan di mst_employee. */
export async function getWaschenEmployees(employeeIds = null) {
  const filter = employeeIds ? "AND e.employee_id IN (?)" : "";
  const [employees] = await safeQuery(
    `SELECT e.employee_id, e.full_name, e.employee_code, e.position_id, p.position_name
     FROM mst_employee e
     LEFT JOIN mst_position p ON p.position_id = e.position_id
     WHERE e.company_id = ? AND e.is_deleted = 0 AND e.exit_date IS NULL ${filter}
     ORDER BY e.full_name`,
    employeeIds ? [WASCHEN_COMPANY_ID, employeeIds] : [WASCHEN_COMPANY_ID]
  );
  if (!employees.length) return [];

  const [roles] = await safeMyWaschenQuery(
    `SELECT employee_id, outlet_id, role FROM mst_role WHERE employee_id IN (?) ORDER BY is_leader DESC, outlet_id ASC`,
    [employees.map((e) => e.employee_id)]
  );
  const roleByEmployee = new Map();
  for (const role of roles) if (!roleByEmployee.has(role.employee_id)) roleByEmployee.set(role.employee_id, role);

  return employees.map((e) => ({
    ...e,
    outlet_id: roleByEmployee.get(e.employee_id)?.outlet_id ?? null,
    role: roleByEmployee.get(e.employee_id)?.role ?? null,
  }));
}

async function getOutletNames() {
  const [outlets] = await safeQuery(`SELECT id, name FROM mst_outlet ORDER BY name`);
  return outlets;
}

/** Topik training beserta kelengkapannya di versi tertentu. */
async function getTopicReadiness(runQuery, trainingId, versionId) {
  const [topics] = await runQuery(
    `SELECT tp.id, tp.name, tp.is_active,
            (SELECT COUNT(*) FROM mst_question q WHERE q.version_id = ? AND q.topic_id = tp.id AND q.phase = 'PRE') AS pre_count,
            (SELECT COUNT(*) FROM mst_question q WHERE q.version_id = ? AND q.topic_id = tp.id AND q.phase = 'POST') AS post_count,
            (SELECT COUNT(*) FROM mst_mentor_indicator i WHERE i.version_id = ? AND i.topic_id = tp.id AND i.category = 'PRAKTIK') AS practice_count,
            (SELECT COUNT(*) FROM mst_mentor_indicator i WHERE i.version_id = ? AND i.topic_id = tp.id AND i.category = 'SIKAP') AS attitude_count
     FROM mst_training_topic tp
     WHERE tp.training_id = ?
     ORDER BY tp.id`,
    [versionId, versionId, versionId, versionId, trainingId]
  );
  // Topik siap kalau punya soal Pre dan Post. Topik pengetahuan murni boleh tanpa indikator Praktik.
  return topics.map((t) => ({ ...t, ready: Boolean(t.is_active) && t.pre_count > 0 && t.post_count > 0 }));
}

/** Menghitung ulang nilai mentor dan nilai akhir peserta dari data yang tersimpan. Dipanggil di dalam transaksi. */
export async function recalcParticipant(conn, participantId) {
  const [[row]] = await conn.query(
    `SELECT p.status, p.post_score, v.pass_score, v.pass_with_fix_score, v.practice_weight, v.attitude_weight
     FROM tr_participant p
     JOIN tr_training_batch b ON b.id = p.batch_id
     JOIN mst_training_version v ON v.id = b.version_id
     WHERE p.id = ?`,
    [participantId]
  );
  // Praktik hanya dari topik yang di-assign (topik yang dicabut tidak ikut terhitung). Sikap berlaku untuk semua peserta.
  const [scores] = await conn.query(
    `SELECT i.category, s.score
     FROM tr_mentor_score s
     JOIN mst_mentor_indicator i ON i.id = s.indicator_id
     WHERE s.participant_id = ?
       AND (i.category = 'SIKAP' OR i.topic_id IN (SELECT topic_id FROM tr_participant_topic WHERE participant_id = ?))`,
    [participantId, participantId]
  );

  const result =
    row.status === "ABSENT"
      ? { practice_score: null, attitude_score: null, mentor_score: null, final_score: null, result_status: null }
      : computeParticipantScores({
          postScore: row.post_score,
          practiceScores: scores.filter((s) => s.category === "PRAKTIK").map((s) => s.score),
          attitudeScores: scores.filter((s) => s.category === "SIKAP").map((s) => s.score),
          version: row,
        });

  await conn.query(
    `UPDATE tr_participant
     SET practice_score = ?, attitude_score = ?, mentor_score = ?, final_score = ?, result_status = ?
     WHERE id = ?`,
    [result.practice_score, result.attitude_score, result.mentor_score, result.final_score, result.result_status, participantId]
  );
}

/** Indikator mentor milik peserta: versi batch. Praktik difilter topik yang di-assign, Sikap berlaku untuk semua. */
async function getParticipantIndicators(runQuery, participantId) {
  const [indicators] = await runQuery(
    `SELECT i.id, i.category, i.indicator_text, COALESCE(tp.name, 'Sikap') AS topic_name
     FROM tr_participant p
     JOIN tr_training_batch b ON b.id = p.batch_id
     JOIN mst_mentor_indicator i ON i.version_id = b.version_id
     LEFT JOIN mst_training_topic tp ON tp.id = i.topic_id
     WHERE p.id = ?
       AND (i.category = 'SIKAP' OR i.topic_id IN (SELECT topic_id FROM tr_participant_topic WHERE participant_id = p.id))
     ORDER BY i.category, i.sort_order, i.id`,
    [participantId]
  );
  return indicators;
}

/**
 * Menghitung ulang nilai pre dan post dari jawaban yang tersimpan, lalu nilai mentor dan nilai akhir.
 * Fase tanpa jawaban dilewati, supaya nilai 0 dari HR (peserta ditutup) tidak tertimpa.
 */
async function recalcTestScores(conn, participantId) {
  for (const [phase, column] of [["PRE", "pre_score"], ["POST", "post_score"]]) {
    const [answers] = await conn.query(
      `SELECT q.type, a.is_correct,
              (SELECT COUNT(*) FROM mst_question_option o WHERE o.question_id = q.id AND o.is_correct = 1) AS correct_count
       FROM tr_test_answer a JOIN mst_question q ON q.id = a.question_id
       WHERE a.participant_id = ? AND a.phase = ?`,
      [participantId, phase]
    );
    if (!answers.length) continue;
    const scored = answers.map((a) => ({ ...a, max_points: questionMaxPoints(a.type, a.correct_count) }));
    await conn.query(`UPDATE tr_participant SET ${column} = ? WHERE id = ?`, [testScoreFromAnswers(scored), participantId]);
  }
  await recalcParticipant(conn, participantId);
}

// ─── Pilihan untuk form batch ──────────────────────────────────────────────

export const getBatchOptions = async (_req, res) => {
  try {
    const [trainings] = await safeAcademyQuery(
      `SELECT t.id, t.name,
              (SELECT v.id FROM mst_training_version v WHERE v.training_id = t.id ORDER BY v.version_no DESC LIMIT 1) AS version_id
       FROM mst_training t WHERE t.is_active = 1 ORDER BY t.name`
    );
    for (const training of trainings) {
      training.topics = await getTopicReadiness(safeAcademyQuery, training.id, training.version_id);
    }

    const [positions] = await safeAcademyQuery(`SELECT id, name FROM mst_sm_position WHERE is_active = 1 ORDER BY sort_order, name`);
    const [requests] = await safeQuery(
      `SELECT id, training_code, topic, scheduled_date FROM tr_training_management
       WHERE status = 'Scheduled' AND company_id = ? ORDER BY scheduled_date`,
      [WASCHEN_COMPANY_ID]
    );
    const [mentorOptions] = await safeQuery(
      `SELECT employee_id, full_name FROM mst_employee WHERE is_deleted = 0 AND exit_date IS NULL ORDER BY full_name`
    );

    res.json({
      trainings,
      positions,
      requests,
      mentorOptions,
      employees: await getWaschenEmployees(),
      outlets: await getOutletNames(),
    });
  } catch (err) {
    console.error("getBatchOptions error:", err);
    res.status(500).json({ message: "Gagal memuat pilihan batch" });
  }
};

/** Isi awal batch dari pengajuan lama. Peserta yang sudah keluar atau bukan Waschen dibuang. */
export const getRequestPrefill = async (req, res) => {
  try {
    const [[request]] = await safeQuery(
      `SELECT id, training_code, topic, scheduled_date FROM tr_training_management
       WHERE id = ? AND status = 'Scheduled' AND company_id = ?`,
      [req.params.id, WASCHEN_COMPANY_ID]
    );
    if (!request) return res.status(404).json({ message: "Pengajuan terjadwal Waschen tidak ditemukan" });

    const [trainees] = await safeQuery(`SELECT employee_id FROM tr_training_trainees WHERE training_id = ?`, [request.id]);
    const [mentors] = await safeQuery(`SELECT employee_id FROM tr_training_mentors WHERE training_id = ?`, [request.id]);
    const [vendors] = await safeQuery(`SELECT vendor_name FROM tr_training_vendors WHERE training_id = ?`, [request.id]);
    const active = trainees.length ? await getWaschenEmployees(trainees.map((t) => t.employee_id)) : [];

    res.json({
      request,
      employee_ids: active.map((e) => e.employee_id),
      skipped_count: trainees.length - active.length,
      mentors: [
        ...mentors.map((m) => ({ employee_id: m.employee_id })),
        ...vendors.filter((v) => v.vendor_name).map((v) => ({ vendor_name: v.vendor_name })),
      ],
    });
  } catch (err) {
    console.error("getRequestPrefill error:", err);
    res.status(500).json({ message: "Gagal memuat pengajuan" });
  }
};

// ─── Batch ─────────────────────────────────────────────────────────────────

export const getBatches = async (_req, res) => {
  try {
    const [rows] = await safeAcademyQuery(
      `SELECT b.id, b.source, b.request_code, b.start_at, b.status, b.start_at <= NOW() AS started,
              t.name AS training_name, v.version_no, sp.name AS position_name,
              (SELECT COUNT(*) FROM tr_participant p WHERE p.batch_id = b.id) AS participant_count,
              (SELECT COUNT(*) FROM tr_participant p WHERE p.batch_id = b.id AND p.final_score IS NOT NULL) AS scored_count
       FROM tr_training_batch b
       JOIN mst_training t ON t.id = b.training_id
       JOIN mst_training_version v ON v.id = b.version_id
       LEFT JOIN mst_sm_position sp ON sp.id = b.sm_position_id
       ORDER BY b.start_at DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("getBatches error:", err);
    res.status(500).json({ message: "Gagal memuat batch" });
  }
};

export const getBatchById = async (req, res) => {
  try {
    const [[batch]] = await safeAcademyQuery(
      `SELECT b.*, b.start_at <= NOW() AS started, t.name AS training_name,
              v.version_no, v.pass_score, v.pass_with_fix_score, sp.name AS position_name
       FROM tr_training_batch b
       JOIN mst_training t ON t.id = b.training_id
       JOIN mst_training_version v ON v.id = b.version_id
       LEFT JOIN mst_sm_position sp ON sp.id = b.sm_position_id
       WHERE b.id = ?`,
      [req.params.id]
    );
    if (!batch) return res.status(404).json({ message: "Batch tidak ditemukan" });

    const [mentors] = await safeAcademyQuery(`SELECT employee_id, vendor_name FROM tr_batch_mentor WHERE batch_id = ?`, [batch.id]);
    const [participants] = await safeAcademyQuery(
      `SELECT p.id, p.employee_id, p.outlet_id, p.role, p.status, p.pre_score, p.post_score, p.practice_score,
              p.attitude_score, p.mentor_score, p.feedback_score, p.final_score, p.result_status,
              (SELECT COUNT(*) FROM tr_test_answer a JOIN mst_question q ON q.id = a.question_id
               WHERE a.participant_id = p.id AND q.type = 'ESSAY') AS essay_count,
              (SELECT COUNT(*) FROM tr_test_answer a JOIN mst_question q ON q.id = a.question_id
               WHERE a.participant_id = p.id AND q.type = 'ESSAY' AND a.is_correct IS NULL) AS essay_pending
       FROM tr_participant p WHERE p.batch_id = ? ORDER BY p.id`,
      [batch.id]
    );
    const [topics] = participants.length
      ? await safeAcademyQuery(
          `SELECT pt.participant_id, pt.topic_id, tp.name FROM tr_participant_topic pt
           JOIN mst_training_topic tp ON tp.id = pt.topic_id WHERE pt.participant_id IN (?)`,
          [participants.map((p) => p.id)]
        )
      : [[]];

    const employeeIds = [...new Set([...participants.map((p) => p.employee_id), ...mentors.map((m) => m.employee_id).filter(Boolean)])];
    const [employees] = employeeIds.length
      ? await safeQuery(`SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (?)`, [employeeIds])
      : [[]];
    const nameById = new Map(employees.map((e) => [e.employee_id, e.full_name]));
    const outletById = new Map((await getOutletNames()).map((o) => [o.id, o.name]));
    const topicsByParticipant = groupBy(topics, "participant_id");

    res.json({
      data: {
        ...batch,
        started: Boolean(batch.started),
        mentors: mentors.map((m) => ({ ...m, full_name: m.employee_id ? nameById.get(m.employee_id) : null })),
        participants: participants.map((p) => ({
          ...p,
          full_name: nameById.get(p.employee_id) ?? "Karyawan tidak ditemukan",
          outlet_name: outletById.get(p.outlet_id) ?? "-",
          topics: (topicsByParticipant.get(p.id) ?? []).map((t) => ({ id: t.topic_id, name: t.name })),
        })),
      },
    });
  } catch (err) {
    console.error("getBatchById error:", err);
    res.status(500).json({ message: "Gagal memuat detail batch" });
  }
};

/** Validasi bersama untuk buat dan edit batch. Mengembalikan pesan error atau data yang siap ditulis. */
async function prepareBatch(conn, body, trainingId, isEdit = false) {
  // Kunci yang sama dengan simpan isi training, supaya versi tidak berganti di tengah pembuatan batch.
  const [[training]] = await conn.query(`SELECT id, is_active FROM mst_training WHERE id = ? FOR UPDATE`, [trainingId]);
  if (!training) return { error: "Training tidak ditemukan" };

  const [[version]] = await conn.query(
    `SELECT id FROM mst_training_version WHERE training_id = ? ORDER BY version_no DESC LIMIT 1`,
    [trainingId]
  );
  const topics = await getTopicReadiness((sql, params) => conn.query(sql, params), trainingId, version.id);
  const [[attitude]] = await conn.query(
    `SELECT COUNT(*) AS n FROM mst_mentor_indicator WHERE version_id = ? AND category = 'SIKAP'`,
    [version.id]
  );
  if (!attitude.n) return { error: "Training belum punya indikator Sikap" };

  const error = validateBatchPayload(
    body,
    topics.filter((t) => t.ready).map((t) => t.id),
    topics.filter((t) => t.practice_count > 0).map((t) => t.id)
  );
  if (error) return { error };

  const participantIds = body.participants.map((p) => Number(p.employee_id));
  const employees = await getWaschenEmployees(participantIds);
  if (employees.length !== participantIds.length) return { error: "Ada peserta yang bukan karyawan Waschen aktif" };

  const mentorIds = body.mentors.filter((m) => m.employee_id).map((m) => Number(m.employee_id));
  if (mentorIds.length) {
    const [found] = await safeQuery(
      `SELECT employee_id FROM mst_employee WHERE employee_id IN (?) AND is_deleted = 0`,
      [mentorIds]
    );
    if (found.length !== new Set(mentorIds).size) return { error: "Ada mentor yang tidak ditemukan" };
  }

  let requestCode = null;
  // Saat edit, pengajuan boleh sudah diselesaikan di alur lama. Status hanya dicek saat batch dibuat.
  if (body.source === "REQUEST" && !isEdit) {
    const [[request]] = await safeQuery(
      `SELECT training_code FROM tr_training_management WHERE id = ? AND status = 'Scheduled' AND company_id = ?`,
      [body.request_id, WASCHEN_COMPANY_ID]
    );
    if (!request) return { error: "Pengajuan harus berstatus terjadwal dan milik Waschen" };
    requestCode = request.training_code;
  }
  if (body.source === "SKILL_MATRIX") {
    const [[position]] = await conn.query(`SELECT id FROM mst_sm_position WHERE id = ?`, [body.sm_position_id]);
    if (!position) return { error: "Posisi skill matrix tidak ditemukan" };
  }

  return {
    versionId: version.id,
    trainingActive: Boolean(training.is_active),
    requestCode,
    employeeById: new Map(employees.map((e) => [e.employee_id, e])),
  };
}

async function writeMentors(conn, batchId, mentors, userId) {
  await conn.query(`DELETE FROM tr_batch_mentor WHERE batch_id = ?`, [batchId]);
  for (const mentor of mentors) {
    await conn.query(
      `INSERT INTO tr_batch_mentor (batch_id, employee_id, vendor_name, created_by) VALUES (?, ?, ?, ?)`,
      [batchId, mentor.employee_id || null, mentor.employee_id ? null : mentor.vendor_name.trim(), userId]
    );
  }
}

async function writeTopics(conn, participantId, topicIds, userId) {
  await conn.query(`DELETE FROM tr_participant_topic WHERE participant_id = ?`, [participantId]);
  for (const topicId of new Set(topicIds.map(Number))) {
    await conn.query(
      `INSERT INTO tr_participant_topic (participant_id, topic_id, created_by) VALUES (?, ?, ?)`,
      [participantId, topicId, userId]
    );
  }
}

async function insertParticipant(conn, batchId, participant, employee, userId) {
  const [inserted] = await conn.query(
    `INSERT INTO tr_participant (batch_id, employee_id, outlet_id, role, created_by) VALUES (?, ?, ?, ?, ?)`,
    [batchId, employee.employee_id, employee.outlet_id, employee.role, userId]
  );
  await writeTopics(conn, inserted.insertId, participant.topic_ids, userId);
}

export const createBatch = async (req, res) => {
  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const body = { mentors: [], participants: [], ...req.body };
    const userId = req.session.employeeId;
    const prepared = await prepareBatch(conn, body, req.body.training_id);
    if (prepared.error || !prepared.trainingActive) {
      await conn.rollback();
      return res.status(400).json({ message: prepared.error ?? "Training sudah nonaktif" });
    }

    const [batch] = await conn.query(
      `INSERT INTO tr_training_batch (training_id, version_id, source, request_id, request_code, sm_position_id, start_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.body.training_id,
        prepared.versionId,
        body.source,
        body.source === "REQUEST" ? body.request_id : null,
        prepared.requestCode,
        body.source === "SKILL_MATRIX" ? body.sm_position_id : null,
        toMysqlDatetime(body.start_at),
        userId,
      ]
    );
    await writeMentors(conn, batch.insertId, body.mentors, userId);
    for (const participant of body.participants) {
      await insertParticipant(conn, batch.insertId, participant, prepared.employeeById.get(Number(participant.employee_id)), userId);
    }

    await conn.commit();
    res.status(201).json({ id: batch.insertId });
  } catch (err) {
    await conn.rollback();
    console.error("createBatch error:", err);
    res.status(500).json({ message: "Gagal membuat batch" });
  } finally {
    conn.release();
  }
};

/** Mengunci batch yang belum mulai dan belum dibatalkan. */
async function lockEditableBatch(conn, batchId) {
  const [[batch]] = await conn.query(
    `SELECT id, training_id, status, start_at <= NOW() AS started FROM tr_training_batch WHERE id = ? FOR UPDATE`,
    [batchId]
  );
  if (!batch) return { status: 404, message: "Batch tidak ditemukan" };
  if (batch.status === "CANCELLED") return { status: 400, message: "Batch sudah dibatalkan" };
  if (batch.started) return { status: 400, message: "Batch sudah dimulai, jadwal dan peserta tidak bisa diubah" };
  return { batch };
}

export const updateBatch = async (req, res) => {
  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session.employeeId;
    const locked = await lockEditableBatch(conn, req.params.id);
    if (!locked.batch) {
      await conn.rollback();
      return res.status(locked.status).json({ message: locked.message });
    }

    // Sumber dan versi tidak berubah saat edit. Hanya jadwal, mentor, dan peserta.
    const [[current]] = await conn.query(
      `SELECT source, request_id, sm_position_id FROM tr_training_batch WHERE id = ?`,
      [locked.batch.id]
    );
    const body = { mentors: [], participants: [], ...req.body, ...current };
    const prepared = await prepareBatch(conn, body, locked.batch.training_id, true);
    if (prepared.error) {
      await conn.rollback();
      return res.status(400).json({ message: prepared.error });
    }

    await conn.query(`UPDATE tr_training_batch SET start_at = ? WHERE id = ?`, [toMysqlDatetime(body.start_at), locked.batch.id]);
    await writeMentors(conn, locked.batch.id, body.mentors, userId);

    const [existing] = await conn.query(`SELECT id, employee_id FROM tr_participant WHERE batch_id = ?`, [locked.batch.id]);
    const existingByEmployee = new Map(existing.map((p) => [p.employee_id, p.id]));
    const wanted = new Set(body.participants.map((p) => Number(p.employee_id)));

    for (const [employeeId, participantId] of existingByEmployee) {
      if (wanted.has(employeeId)) continue;
      // Batch belum mulai, jadi belum ada jawaban test. Nilai mentor yang terlanjur diisi ikut dihapus.
      await conn.query(`DELETE FROM tr_mentor_score WHERE participant_id = ?`, [participantId]);
      await conn.query(`DELETE FROM tr_participant_topic WHERE participant_id = ?`, [participantId]);
      await conn.query(`DELETE FROM tr_participant WHERE id = ?`, [participantId]);
    }
    for (const participant of body.participants) {
      const participantId = existingByEmployee.get(Number(participant.employee_id));
      if (participantId) {
        await writeTopics(conn, participantId, participant.topic_ids, userId);
        await recalcParticipant(conn, participantId);
      } else {
        await insertParticipant(conn, locked.batch.id, participant, prepared.employeeById.get(Number(participant.employee_id)), userId);
      }
    }

    await conn.commit();
    res.json({ message: "Batch diperbarui" });
  } catch (err) {
    await conn.rollback();
    console.error("updateBatch error:", err);
    res.status(500).json({ message: "Gagal memperbarui batch" });
  } finally {
    conn.release();
  }
};

export const cancelBatch = async (req, res) => {
  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const locked = await lockEditableBatch(conn, req.params.id);
    if (!locked.batch) {
      await conn.rollback();
      return res.status(locked.status).json({ message: locked.message });
    }
    await conn.query(`UPDATE tr_training_batch SET status = 'CANCELLED' WHERE id = ?`, [locked.batch.id]);
    await conn.commit();
    res.json({ message: "Batch dibatalkan" });
  } catch (err) {
    await conn.rollback();
    console.error("cancelBatch error:", err);
    res.status(500).json({ message: "Gagal membatalkan batch" });
  } finally {
    conn.release();
  }
};

// ─── Peserta ───────────────────────────────────────────────────────────────

/** Mengunci peserta dari batch yang tidak dibatalkan. */
async function lockParticipant(conn, participantId) {
  const [[participant]] = await conn.query(
    `SELECT p.id, p.status, p.pre_score, b.status AS batch_status, b.start_at <= NOW() AS started
     FROM tr_participant p JOIN tr_training_batch b ON b.id = p.batch_id
     WHERE p.id = ? FOR UPDATE`,
    [participantId]
  );
  if (!participant) return { status: 404, message: "Peserta tidak ditemukan" };
  if (participant.batch_status === "CANCELLED") return { status: 400, message: "Batch sudah dibatalkan" };
  return { participant };
}

async function withParticipant(req, res, label, action) {
  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const locked = await lockParticipant(conn, req.params.id);
    const failure = locked.participant ? await action(conn, locked.participant) : locked;
    if (failure) {
      await conn.rollback();
      return res.status(failure.status).json({ message: failure.message });
    }
    await conn.commit();
    res.json({ message: "Tersimpan" });
  } catch (err) {
    await conn.rollback();
    console.error(`${label} error:`, err);
    res.status(500).json({ message: "Gagal menyimpan data peserta" });
  } finally {
    conn.release();
  }
}

export const setAttendance = (req, res) =>
  withParticipant(req, res, "setAttendance", async (conn, participant) => {
    const absent = Boolean(req.body.absent);
    if (absent && participant.status !== "ASSIGNED") {
      return { status: 400, message: "Peserta sudah mengerjakan test, tidak bisa ditandai tidak hadir" };
    }
    if (!absent && participant.status !== "ABSENT") return null;

    await conn.query(`UPDATE tr_participant SET status = ? WHERE id = ?`, [absent ? "ABSENT" : "ASSIGNED", participant.id]);
    await recalcParticipant(conn, participant.id);
    return null;
  });

/** HR menutup peserta yang hadir tapi tidak menyelesaikan test: nilai yang kosong menjadi 0. */
export const closeParticipant = (req, res) =>
  withParticipant(req, res, "closeParticipant", async (conn, participant) => {
    if (!participant.started) return { status: 400, message: "Batch belum dimulai" };
    if (!["ASSIGNED", "PRE_DONE"].includes(participant.status)) {
      return { status: 400, message: "Peserta sudah menyelesaikan post-test atau ditandai tidak hadir" };
    }

    await conn.query(
      `UPDATE tr_participant SET pre_score = COALESCE(pre_score, 0), post_score = 0, status = 'POST_DONE' WHERE id = ?`,
      [participant.id]
    );
    await recalcParticipant(conn, participant.id);
    return null;
  });

export const getMentorForm = async (req, res) => {
  try {
    const indicators = await getParticipantIndicators(safeAcademyQuery, req.params.id);
    const [scores] = await safeAcademyQuery(`SELECT indicator_id, score FROM tr_mentor_score WHERE participant_id = ?`, [req.params.id]);
    const [feedback] = await safeAcademyQuery(
      `SELECT q.type, q.question_text, a.score, a.answer_text
       FROM tr_feedback_answer a JOIN mst_feedback_question q ON q.id = a.feedback_question_id
       WHERE a.participant_id = ? ORDER BY q.sort_order, q.id`,
      [req.params.id]
    );
    const scoreById = new Map(scores.map((s) => [s.indicator_id, s.score]));
    res.json({
      indicators: indicators.map((i) => ({ ...i, score: scoreById.get(i.id) ?? null })),
      feedback,
    });
  } catch (err) {
    console.error("getMentorForm error:", err);
    res.status(500).json({ message: "Gagal memuat penilaian mentor" });
  }
};

/** Nilai mentor bisa diisi kapan saja. Nilai akhir terisi kalau post-test sudah ada. */
export const saveMentorScores = (req, res) =>
  withParticipant(req, res, "saveMentorScores", async (conn, participant) => {
    if (participant.status === "ABSENT") return { status: 400, message: "Peserta ditandai tidak hadir" };

    const indicators = await getParticipantIndicators((sql, params) => conn.query(sql, params), participant.id);
    const submitted = new Map((req.body.scores ?? []).map((s) => [Number(s.indicator_id), Number(s.score)]));
    for (const indicator of indicators) {
      const score = submitted.get(indicator.id);
      if (!Number.isInteger(score) || score < 1 || score > 4) {
        return { status: 400, message: "Semua indikator wajib dinilai 1 sampai 4" };
      }
    }

    for (const indicator of indicators) {
      await conn.query(
        `INSERT INTO tr_mentor_score (participant_id, indicator_id, score, created_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE score = VALUES(score)`,
        [participant.id, indicator.id, submitted.get(indicator.id), req.session.employeeId]
      );
    }
    await recalcParticipant(conn, participant.id);
    return null;
  });

/** Jawaban essay peserta beserta panduan penilai, untuk dinilai HR. */
export const getEssays = async (req, res) => {
  try {
    const [rows] = await safeAcademyQuery(
      `SELECT a.id, a.phase, a.answer_text, a.is_correct, q.question_text, q.answer_guide, q.keywords, tp.name AS topic_name
       FROM tr_test_answer a
       JOIN mst_question q ON q.id = a.question_id
       JOIN mst_training_topic tp ON tp.id = q.topic_id
       WHERE a.participant_id = ? AND q.type = 'ESSAY'
       ORDER BY a.phase, q.sort_order, q.id`,
      [req.params.id]
    );
    res.json({ data: rows.map(({ keywords, ...r }) => ({ ...r, keyword_match: matchKeywords(r.answer_text, keywords) })) });
  } catch (err) {
    console.error("getEssays error:", err);
    res.status(500).json({ message: "Gagal memuat jawaban essay" });
  }
};

/** HR menilai essay 0 (salah), 1 (benar, kurang lengkap), atau 2 (benar lengkap). Nilai pre atau post terisi setelah semua soalnya ternilai, lalu nilai akhir ikut dihitung. */
export const gradeEssays = (req, res) =>
  withParticipant(req, res, "gradeEssays", async (conn, participant) => {
    const grades = Array.isArray(req.body.grades) ? req.body.grades : [];
    if (!grades.length) return { status: 400, message: "Tidak ada penilaian yang dikirim" };

    const [essays] = await conn.query(
      `SELECT a.id FROM tr_test_answer a JOIN mst_question q ON q.id = a.question_id
       WHERE a.participant_id = ? AND q.type = 'ESSAY'`,
      [participant.id]
    );
    const essayIds = new Set(essays.map((e) => e.id));

    for (const grade of grades) {
      if (!essayIds.has(Number(grade.answer_id)) || ![0, 1, 2].includes(grade.is_correct)) {
        return { status: 400, message: "Penilaian essay tidak valid" };
      }
    }
    for (const grade of grades) {
      await conn.query(`UPDATE tr_test_answer SET is_correct = ? WHERE id = ?`, [grade.is_correct, Number(grade.answer_id)]);
    }
    await recalcTestScores(conn, participant.id);
    return null;
  });
