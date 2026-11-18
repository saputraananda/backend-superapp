import { academyPool, safeAcademyQuery } from "../../db/pool.js";
import { saveVersionContent } from "./utils/academyVersion.js";

const groupBy = (rows, key) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
};

export const getTrainings = async (_req, res) => {
  try {
    const [rows] = await safeAcademyQuery(
      `SELECT t.id, t.name, t.is_active,
              (SELECT COUNT(*) FROM mst_training_topic tp WHERE tp.training_id = t.id AND tp.is_active = 1) AS topic_count,
              (SELECT MAX(v.version_no) FROM mst_training_version v WHERE v.training_id = t.id) AS version_no
       FROM mst_training t
       ORDER BY t.is_active DESC, t.name ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("getTrainings error:", err);
    res.status(500).json({ message: "Gagal memuat training" });
  }
};

export const getTrainingById = async (req, res) => {
  try {
    const { id } = req.params;
    const [[training]] = await safeAcademyQuery(`SELECT * FROM mst_training WHERE id = ?`, [id]);
    if (!training) return res.status(404).json({ message: "Training tidak ditemukan" });

    const [topics] = await safeAcademyQuery(
      `SELECT id, name, is_active FROM mst_training_topic WHERE training_id = ? ORDER BY is_active DESC, id ASC`,
      [id]
    );
    const [materials] = await safeAcademyQuery(
      `SELECT id, file_name, file_path FROM mst_training_material WHERE training_id = ? AND is_active = 1 ORDER BY id DESC`,
      [id]
    );
    const [[version]] = await safeAcademyQuery(
      `SELECT id, version_no, pass_score, pass_with_fix_score, practice_weight, attitude_weight FROM mst_training_version
       WHERE training_id = ? ORDER BY version_no DESC LIMIT 1`,
      [id]
    );
    const [[usage]] = await safeAcademyQuery(`SELECT COUNT(*) AS n FROM tr_training_batch WHERE version_id = ?`, [version.id]);

    const [questions] = await safeAcademyQuery(
      `SELECT id, topic_id, phase, type, question_text, answer_guide, keywords FROM mst_question WHERE version_id = ? ORDER BY sort_order, id`,
      [version.id]
    );
    const [options] = await safeAcademyQuery(
      `SELECT o.question_id, o.option_text, o.is_correct
       FROM mst_question_option o JOIN mst_question q ON q.id = o.question_id
       WHERE q.version_id = ? ORDER BY o.sort_order, o.id`,
      [version.id]
    );
    const optionsByQuestion = groupBy(options, "question_id");

    const [feedback_questions] = await safeAcademyQuery(
      `SELECT type, question_text FROM mst_feedback_question WHERE version_id = ? ORDER BY sort_order, id`,
      [version.id]
    );
    const [indicators] = await safeAcademyQuery(
      `SELECT category, topic_id, indicator_text FROM mst_mentor_indicator WHERE version_id = ? ORDER BY sort_order, id`,
      [version.id]
    );

    res.json({
      data: {
        ...training,
        topics,
        materials,
        version: { ...version, in_use: usage.n > 0 },
        questions: questions.map((q) => ({
          ...q,
          options: (optionsByQuestion.get(q.id) ?? []).map((o) => ({
            option_text: o.option_text,
            is_correct: Boolean(o.is_correct),
          })),
        })),
        feedback_questions,
        indicators,
      },
    });
  } catch (err) {
    console.error("getTrainingById error:", err);
    res.status(500).json({ message: "Gagal memuat detail training" });
  }
};

export const createTraining = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama training wajib diisi" });

  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const userId = req.session.employeeId;
    const [training] = await conn.query(`INSERT INTO mst_training (name, created_by) VALUES (?, ?)`, [name, userId]);
    await conn.query(
      `INSERT INTO mst_training_version (training_id, version_no, created_by) VALUES (?, 1, ?)`,
      [training.insertId, userId]
    );
    await conn.commit();
    res.status(201).json({ id: training.insertId });
  } catch (err) {
    await conn.rollback();
    console.error("createTraining error:", err);
    res.status(500).json({ message: "Gagal membuat training" });
  } finally {
    conn.release();
  }
};

export const updateTraining = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama training wajib diisi" });
  if (name.length > 150) return res.status(400).json({ message: "Nama training maksimal 150 karakter" });

  try {
    const [result] = await safeAcademyQuery(`UPDATE mst_training SET name = ?, is_active = ? WHERE id = ?`, [
      name,
      req.body.is_active ? 1 : 0,
      req.params.id,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: "Training tidak ditemukan" });
    res.json({ message: "Training diperbarui" });
  } catch (err) {
    console.error("updateTraining error:", err);
    res.status(500).json({ message: "Gagal memperbarui training" });
  }
};

export const createTopic = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama topik wajib diisi" });

  try {
    const [[training]] = await safeAcademyQuery(`SELECT id FROM mst_training WHERE id = ?`, [req.params.id]);
    if (!training) return res.status(404).json({ message: "Training tidak ditemukan" });

    const [result] = await safeAcademyQuery(
      `INSERT INTO mst_training_topic (training_id, name, created_by) VALUES (?, ?, ?)`,
      [req.params.id, name, req.session.employeeId]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("createTopic error:", err);
    res.status(500).json({ message: "Gagal menambah topik" });
  }
};

export const updateTopic = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama topik wajib diisi" });

  try {
    const [result] = await safeAcademyQuery(`UPDATE mst_training_topic SET name = ?, is_active = ? WHERE id = ?`, [
      name,
      req.body.is_active ? 1 : 0,
      req.params.topicId,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: "Topik tidak ditemukan" });
    res.json({ message: "Topik diperbarui" });
  } catch (err) {
    console.error("updateTopic error:", err);
    res.status(500).json({ message: "Gagal memperbarui topik" });
  }
};

export const saveContent = async (req, res) => {
  const conn = await academyPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await saveVersionContent(conn, Number(req.params.id), req.body, req.session.employeeId);

    if (result.notFound || result.error) {
      await conn.rollback();
      return result.notFound
        ? res.status(404).json({ message: "Training tidak ditemukan" })
        : res.status(400).json({ message: result.error });
    }

    await conn.commit();
    res.json({
      ...result,
      message: result.isNewVersion
        ? `Tersimpan sebagai versi ${result.versionNo}. Batch lama tetap memakai versi sebelumnya.`
        : "Isi training tersimpan",
    });
  } catch (err) {
    await conn.rollback();
    console.error("saveContent error:", err);
    res.status(500).json({ message: "Gagal menyimpan isi training" });
  } finally {
    conn.release();
  }
};

export const uploadMaterial = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "File materi wajib dipilih" });

  try {
    const [[training]] = await safeAcademyQuery(`SELECT id FROM mst_training WHERE id = ?`, [req.params.id]);
    if (!training) return res.status(404).json({ message: "Training tidak ditemukan" });

    const [result] = await safeAcademyQuery(
      `INSERT INTO mst_training_material (training_id, file_name, file_path, created_by) VALUES (?, ?, ?, ?)`,
      [req.params.id, req.file.originalname, `academy_material/${req.file.filename}`, req.session.employeeId]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error("uploadMaterial error:", err);
    res.status(500).json({ message: "Gagal menyimpan materi" });
  }
};

export const deleteMaterial = async (req, res) => {
  try {
    const [result] = await safeAcademyQuery(`UPDATE mst_training_material SET is_active = 0 WHERE id = ?`, [req.params.materialId]);
    if (!result.affectedRows) return res.status(404).json({ message: "Materi tidak ditemukan" });
    res.json({ message: "Materi dihapus" });
  } catch (err) {
    console.error("deleteMaterial error:", err);
    res.status(500).json({ message: "Gagal menghapus materi" });
  }
};
