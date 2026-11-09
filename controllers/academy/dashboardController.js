import { safeAcademyQuery, safeQuery } from "../../db/pool.js";
import { indicatorAverages, summarizeTraining } from "./utils/academyDashboard.js";

const MONTH = /^\d{4}-\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const round1 = (value) => Math.round((value + Number.EPSILON) * 10) / 10;

async function getNames(employeeIds) {
  if (!employeeIds.length) return new Map();
  const [rows] = await safeQuery(`SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (?)`, [employeeIds]);
  return new Map(rows.map((r) => [r.employee_id, r.full_name]));
}

export const getTrainingDashboard = async (req, res) => {
  try {
    const [[{ current }]] = await safeAcademyQuery(`SELECT DATE_FORMAT(NOW(), '%Y-%m') AS current`);
    const month = MONTH.test(String(req.query.month)) ? req.query.month : current;

    const [participants] = await safeAcademyQuery(
      `SELECT p.id, p.employee_id, p.batch_id, p.status, p.pre_score, p.post_score, p.mentor_score, p.feedback_score, p.result_status
       FROM tr_participant p
       JOIN tr_training_batch b ON b.id = p.batch_id
       WHERE b.status = 'SCHEDULED' AND DATE_FORMAT(b.start_at, '%Y-%m') = ?`,
      [month]
    );

    let weakTopics = [];
    if (participants.length) {
      const ids = participants.map((p) => p.id);
      // Topik perlu perbaikan: soal post-test yang salah atau indikator mentor di bawah 2,5.
      const [rows] = await safeAcademyQuery(
        `SELECT tp.id AS topic_id, tp.name AS topic_name, t.name AS training_name, a.participant_id
         FROM tr_test_answer a
         JOIN mst_question q ON q.id = a.question_id
         JOIN mst_training_topic tp ON tp.id = q.topic_id
         JOIN mst_training t ON t.id = tp.training_id
         WHERE a.phase = 'POST' AND a.is_correct = 0 AND a.participant_id IN (?)
         UNION
         SELECT tp.id, tp.name, t.name, s.participant_id
         FROM tr_mentor_score s
         JOIN mst_mentor_indicator i ON i.id = s.indicator_id
         JOIN tr_participant_topic pt ON pt.participant_id = s.participant_id AND pt.topic_id = i.topic_id
         JOIN mst_training_topic tp ON tp.id = i.topic_id
         JOIN mst_training t ON t.id = tp.training_id
         WHERE s.score < 2.5 AND s.participant_id IN (?)`,
        [ids, ids]
      );
      const employeeByParticipant = new Map(participants.map((p) => [p.id, p.employee_id]));
      const names = await getNames([...new Set(participants.map((p) => p.employee_id))]);

      const byTopic = new Map();
      for (const row of rows) {
        if (!byTopic.has(row.topic_id)) byTopic.set(row.topic_id, { ...row, employees: new Set() });
        byTopic.get(row.topic_id).employees.add(employeeByParticipant.get(row.participant_id));
      }
      weakTopics = [...byTopic.values()]
        .map((t) => ({
          topic_id: t.topic_id,
          topic_name: t.topic_name,
          training_name: t.training_name,
          names: [...t.employees].map((id) => names.get(id) ?? "Karyawan tidak ditemukan").sort(),
        }))
        .sort((a, b) => b.names.length - a.names.length);
    }

    res.json({ month, summary: summarizeTraining(participants), weak_topics: weakTopics });
  } catch (err) {
    console.error("getTrainingDashboard error:", err);
    res.status(500).json({ message: "Gagal memuat dashboard training" });
  }
};

export const getSkillDashboard = async (req, res) => {
  try {
    const { position_id, outlet_id, from, to } = req.query;
    const filters = [];
    const params = [];
    if (Number(outlet_id)) {
      filters.push("outlet_id = ?");
      params.push(Number(outlet_id));
    }
    if (DATE.test(String(from))) {
      filters.push("assessed_at >= ?");
      params.push(from);
    }
    if (DATE.test(String(to))) {
      filters.push("assessed_at < DATE_ADD(?, INTERVAL 1 DAY)");
      params.push(to);
    }
    if (Number(position_id)) {
      filters.push("position_id = ?");
      params.push(Number(position_id));
    }

    // Penilaian terbaru per karyawan per posisi di dalam filter.
    const [assessments] = await safeAcademyQuery(
      `SELECT a.id, a.employee_id, a.position_id, a.score, a.star, sp.name AS position_name
       FROM tr_sm_assessment a
       JOIN (SELECT MAX(id) AS id FROM tr_sm_assessment
             ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
             GROUP BY employee_id, position_id) last ON last.id = a.id
       JOIN mst_sm_position sp ON sp.id = a.position_id
       ORDER BY sp.sort_order, sp.name`,
      params
    );
    const [positions] = await safeAcademyQuery(`SELECT id, name FROM mst_sm_position WHERE is_active = 1 ORDER BY sort_order, name`);
    const [outlets] = await safeQuery(`SELECT id, name FROM mst_outlet ORDER BY name`);
    const names = await getNames([...new Set(assessments.map((a) => a.employee_id))]);

    const byPosition = new Map();
    for (const a of assessments) {
      if (!byPosition.has(a.position_id)) byPosition.set(a.position_id, { position_id: a.position_id, name: a.position_name, rows: [] });
      byPosition.get(a.position_id).rows.push({ ...a, full_name: names.get(a.employee_id) ?? "Karyawan tidak ditemukan" });
    }
    const groups = [...byPosition.values()];
    const people = (rows) => rows.map((r) => ({ employee_id: r.employee_id, full_name: r.full_name, star: r.star, score: r.score }));

    const gapPositionId = Number(position_id) || groups[0]?.position_id;
    const gapIds = assessments.filter((a) => a.position_id === gapPositionId).map((a) => a.id);
    const [details] = gapIds.length
      ? await safeAcademyQuery(
          `SELECT d.indicator_id, i.name AS indicator_name, d.score
           FROM tr_sm_assessment_detail d JOIN mst_sm_indicator i ON i.id = d.indicator_id
           WHERE d.assessment_id IN (?)`,
          [gapIds]
        )
      : [[]];

    res.json({
      positions,
      outlets,
      averages: groups.map((g) => ({
        position_id: g.position_id,
        name: g.name,
        count: g.rows.length,
        average: round1(g.rows.reduce((sum, r) => sum + Number(r.score), 0) / g.rows.length),
      })),
      masters: groups
        .map((g) => ({ position_id: g.position_id, name: g.name, people: people(g.rows.filter((r) => r.star === 4)) }))
        .filter((g) => g.people.length),
      needs_training: groups
        .map((g) => ({ position_id: g.position_id, name: g.name, people: people(g.rows.filter((r) => r.star <= 2)) }))
        .filter((g) => g.people.length),
      gap: {
        position_id: gapPositionId ?? null,
        position_name: groups.find((g) => g.position_id === gapPositionId)?.name ?? null,
        indicators: indicatorAverages(details),
      },
    });
  } catch (err) {
    console.error("getSkillDashboard error:", err);
    res.status(500).json({ message: "Gagal memuat dashboard skill matrix" });
  }
};
