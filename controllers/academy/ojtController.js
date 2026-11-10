import { academyPool, safeAcademyQuery, safeQuery } from "../../db/pool.js";
import { getWaschenEmployees } from "./batchController.js";
import { addDays, dateRange, dayAverage, ojtAverage, ojtPhase, validateOjtPayload } from "./utils/academyOjt.js";

const MAX_NAME_LENGTH = 200;

const endDateOf = (ojt) => addDays(ojt.start_date, ojt.days - 1);

async function getToday() {
  const [[row]] = await safeAcademyQuery(`SELECT CURDATE() AS today`);
  return row.today;
}

async function getNames(employeeIds) {
  if (!employeeIds.length) return new Map();
  const [rows] = await safeQuery(`SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (?)`, [
    [...new Set(employeeIds)],
  ]);
  return new Map(rows.map((r) => [r.employee_id, r.full_name]));
}

/** Nilai harian dari baris tr_ojt_score: { tanggal: [nilai kriteria] }. */
function scoresByDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.score_date)) byDate.set(row.score_date, []);
    byDate.get(row.score_date).push(row);
  }
  return byDate;
}

/** Nilai akhir dan jumlah hari terisi dari semua baris nilai satu OJT. */
function summarize(rows) {
  const averages = [...scoresByDate(rows).values()].map((day) => dayAverage(day.map((r) => r.score)));
  return { scored_days: averages.length, average: ojtAverage(averages) };
}

// ─── Master kriteria ──────────────────────────────────────────────────────

export const getOjtCriteria = async (_req, res) => {
  try {
    const [rows] = await safeAcademyQuery(`SELECT id, name, is_active FROM mst_ojt_criterion ORDER BY is_active DESC, name`);
    res.json({ data: rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) })) });
  } catch (err) {
    console.error("getOjtCriteria error:", err);
    res.status(500).json({ message: "Gagal memuat kriteria OJT" });
  }
};

/** Nama kriteria: wajib, maksimal 200 karakter, tidak boleh kembar (huruf besar kecil dianggap sama). */
async function checkCriterionName(name, exceptId = 0) {
  if (!name) return "Nama kriteria wajib diisi";
  if (name.length > MAX_NAME_LENGTH) return `Nama kriteria maksimal ${MAX_NAME_LENGTH} karakter`;
  const [same] = await safeAcademyQuery(`SELECT id FROM mst_ojt_criterion WHERE LOWER(name) = LOWER(?) AND id <> ? LIMIT 1`, [
    name,
    exceptId,
  ]);
  return same.length ? "Kriteria dengan nama itu sudah ada" : null;
}

export const createOjtCriterion = async (req, res) => {
  try {
    const name = String(req.body.name ?? "").trim();
    const problem = await checkCriterionName(name);
    if (problem) return res.status(400).json({ message: problem });

    const [result] = await safeAcademyQuery(`INSERT INTO mst_ojt_criterion (name, created_by) VALUES (?, ?)`, [
      name,
      req.session.employeeId,
    ]);
    res.status(201).json({ id: result.insertId, message: "Kriteria ditambahkan" });
  } catch (err) {
    console.error("createOjtCriterion error:", err);
    res.status(500).json({ message: "Gagal menambah kriteria" });
  }
};

export const updateOjtCriterion = async (req, res) => {
  try {
    const [[current]] = await safeAcademyQuery(`SELECT id, name, is_active FROM mst_ojt_criterion WHERE id = ?`, [req.params.id]);
    if (!current) return res.status(404).json({ message: "Kriteria tidak ditemukan" });

    const name = req.body.name === undefined ? current.name : String(req.body.name).trim();
    const problem = await checkCriterionName(name, current.id);
    if (problem) return res.status(400).json({ message: problem });
    const isActive = req.body.is_active === undefined ? current.is_active : req.body.is_active ? 1 : 0;

    await safeAcademyQuery(`UPDATE mst_ojt_criterion SET name = ?, is_active = ? WHERE id = ?`, [name, isActive, current.id]);
    res.json({ message: "Kriteria diperbarui" });
  } catch (err) {
    console.error("updateOjtCriterion error:", err);
    res.status(500).json({ message: "Gagal memperbarui kriteria" });
  }
};

// ─── Pilihan untuk form OJT ───────────────────────────────────────────────

/** Peserta yang sudah selesai training (semua hasil), karyawan untuk pemantau, dan kriteria aktif. */
export const getOjtOptions = async (_req, res) => {
  try {
    const [participants] = await safeAcademyQuery(
      `SELECT p.id AS participant_id, p.employee_id, p.result_status, b.start_at, t.name AS training_name
       FROM tr_participant p
       JOIN tr_training_batch b ON b.id = p.batch_id
       JOIN mst_training t ON t.id = b.training_id
       WHERE p.status = 'FEEDBACK_DONE' AND b.status = 'SCHEDULED'
       ORDER BY b.start_at DESC, p.id DESC`
    );
    const names = await getNames(participants.map((p) => p.employee_id));
    const employees = await getWaschenEmployees();
    const [criteria] = await safeAcademyQuery(`SELECT id, name FROM mst_ojt_criterion WHERE is_active = 1 ORDER BY name`);

    res.json({
      participants: participants.map((p) => ({ ...p, full_name: names.get(p.employee_id) ?? "Karyawan tidak ditemukan" })),
      employees: employees.map((e) => ({ employee_id: e.employee_id, full_name: e.full_name, position_name: e.position_name })),
      criteria,
    });
  } catch (err) {
    console.error("getOjtOptions error:", err);
    res.status(500).json({ message: "Gagal memuat pilihan OJT" });
  }
};

// ─── OJT ──────────────────────────────────────────────────────────────────

export const getOjtList = async (_req, res) => {
  try {
    const [ojts] = await safeAcademyQuery(
      `SELECT o.id, o.employee_id, o.start_date, o.days, t.name AS training_name
       FROM tr_ojt o
       JOIN tr_participant p ON p.id = o.participant_id
       JOIN tr_training_batch b ON b.id = p.batch_id
       JOIN mst_training t ON t.id = b.training_id
       ORDER BY o.start_date DESC, o.id DESC`
    );
    if (!ojts.length) return res.json({ data: [] });

    const [scores] = await safeAcademyQuery(`SELECT ojt_id, score_date, score FROM tr_ojt_score WHERE ojt_id IN (?)`, [
      ojts.map((o) => o.id),
    ]);
    const scoresByOjt = new Map();
    for (const row of scores) {
      if (!scoresByOjt.has(row.ojt_id)) scoresByOjt.set(row.ojt_id, []);
      scoresByOjt.get(row.ojt_id).push(row);
    }
    const names = await getNames(ojts.map((o) => o.employee_id));
    const today = await getToday();

    res.json({
      data: ojts.map((o) => {
        const end = endDateOf(o);
        return {
          ...o,
          full_name: names.get(o.employee_id) ?? "Karyawan tidak ditemukan",
          end_date: end,
          phase: ojtPhase(o.start_date, end, today),
          ...summarize(scoresByOjt.get(o.id) ?? []),
        };
      }),
    });
  } catch (err) {
    console.error("getOjtList error:", err);
    res.status(500).json({ message: "Gagal memuat daftar OJT" });
  }
};

export const getOjtById = async (req, res) => {
  try {
    const [[ojt]] = await safeAcademyQuery(
      `SELECT o.id, o.participant_id, o.employee_id, o.start_date, o.days, t.name AS training_name, p.result_status
       FROM tr_ojt o
       JOIN tr_participant p ON p.id = o.participant_id
       JOIN tr_training_batch b ON b.id = p.batch_id
       JOIN mst_training t ON t.id = b.training_id
       WHERE o.id = ?`,
      [req.params.id]
    );
    if (!ojt) return res.status(404).json({ message: "OJT tidak ditemukan" });

    const [observers] = await safeAcademyQuery(`SELECT employee_id FROM tr_ojt_observer WHERE ojt_id = ? ORDER BY id`, [ojt.id]);
    const [criteria] = await safeAcademyQuery(
      `SELECT c.id, c.name FROM tr_ojt_criterion oc JOIN mst_ojt_criterion c ON c.id = oc.criterion_id
       WHERE oc.ojt_id = ? ORDER BY c.name`,
      [ojt.id]
    );
    const [scores] = await safeAcademyQuery(
      `SELECT score_date, criterion_id, score, assessor_id FROM tr_ojt_score WHERE ojt_id = ?`,
      [ojt.id]
    );
    const names = await getNames([ojt.employee_id, ...observers.map((o) => o.employee_id), ...scores.map((s) => s.assessor_id)]);
    const criterionName = new Map(criteria.map((c) => [c.id, c.name]));
    const byDate = scoresByDate(scores);
    const end = endDateOf(ojt);
    const today = await getToday();

    const daysDetail = dateRange(ojt.start_date, ojt.days).map((date) => {
      const rows = byDate.get(date);
      return {
        date,
        scored: Boolean(rows),
        average: rows ? dayAverage(rows.map((r) => r.score)) : null,
        assessor_name: rows ? names.get(rows[0].assessor_id) ?? null : null,
        scores: rows ? rows.map((r) => ({ criterion_id: r.criterion_id, name: criterionName.get(r.criterion_id), score: r.score })) : [],
      };
    });

    res.json({
      data: {
        id: ojt.id,
        participant_id: ojt.participant_id,
        employee_id: ojt.employee_id,
        full_name: names.get(ojt.employee_id) ?? "Karyawan tidak ditemukan",
        training_name: ojt.training_name,
        result_status: ojt.result_status,
        start_date: ojt.start_date,
        end_date: end,
        days: ojt.days,
        phase: ojtPhase(ojt.start_date, end, today),
        observers: observers.map((o) => ({ employee_id: o.employee_id, full_name: names.get(o.employee_id) ?? "Karyawan tidak ditemukan" })),
        criteria,
        days_detail: daysDetail,
        ...summarize(scores),
      },
    });
  } catch (err) {
    console.error("getOjtById error:", err);
    res.status(500).json({ message: "Gagal memuat OJT" });
  }
};

/** Pemantau harus karyawan Waschen aktif. Mengembalikan pesan error atau null. */
async function checkObservers(observerIds) {
  const found = await getWaschenEmployees(observerIds);
  return found.length === observerIds.length ? null : "Ada pemantau yang bukan karyawan Waschen aktif";
}

/** Kriteria harus ada dan aktif. Mengembalikan pesan error atau null. */
async function checkCriteria(criterionIds) {
  const [rows] = await safeAcademyQuery(`SELECT id FROM mst_ojt_criterion WHERE id IN (?) AND is_active = 1`, [criterionIds]);
  return rows.length === criterionIds.length ? null : "Ada kriteria yang tidak ditemukan atau sudah nonaktif";
}

const insertRows = (conn, table, column, ojtId, values, userId) =>
  Promise.all(
    values.map((value) =>
      conn.query(`INSERT INTO ${table} (ojt_id, ${column}, created_by) VALUES (?, ?, ?)`, [ojtId, value, userId])
    )
  );

export const createOjt = async (req, res) => {
  const body = req.body;
  const invalid = validateOjtPayload(body);
  if (invalid) return res.status(400).json({ message: invalid });

  try {
    const [[participant]] = await safeAcademyQuery(
      `SELECT id, employee_id FROM tr_participant WHERE id = ? AND status = 'FEEDBACK_DONE'`,
      [body.participant_id]
    );
    if (!participant) return res.status(400).json({ message: "Peserta belum menyelesaikan training" });
    const problem = (await checkObservers(body.observer_ids)) ?? (await checkCriteria(body.criterion_ids));
    if (problem) return res.status(400).json({ message: problem });

    const userId = req.session.employeeId;
    const conn = await academyPool.getConnection();
    try {
      await conn.beginTransaction();
      const [ojt] = await conn.query(
        `INSERT INTO tr_ojt (participant_id, employee_id, start_date, days, created_by) VALUES (?, ?, ?, ?, ?)`,
        [participant.id, participant.employee_id, body.start_date, body.days, userId]
      );
      await insertRows(conn, "tr_ojt_observer", "employee_id", ojt.insertId, body.observer_ids, userId);
      await insertRows(conn, "tr_ojt_criterion", "criterion_id", ojt.insertId, body.criterion_ids, userId);
      await conn.commit();
      res.status(201).json({ id: ojt.insertId, message: "OJT dibuat" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error("createOjt error:", err);
    res.status(500).json({ message: "Gagal membuat OJT" });
  }
};

/** Mengubah tanggal, jumlah hari, dan pemantau. Kriteria hanya bisa diubah selama belum ada nilai. */
export const updateOjt = async (req, res) => {
  const conn = await academyPool.getConnection();
  const fail = async (status, message) => {
    await conn.rollback();
    res.status(status).json({ message });
  };

  try {
    await conn.beginTransaction();
    const [[current]] = await conn.query(`SELECT id, participant_id FROM tr_ojt WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (!current) return await fail(404, "OJT tidak ditemukan");

    const body = { ...req.body, participant_id: current.participant_id };
    const invalid = validateOjtPayload(body);
    if (invalid) return await fail(400, invalid);

    const [scored] = await conn.query(`SELECT DISTINCT score_date FROM tr_ojt_score WHERE ojt_id = ?`, [current.id]);
    const inRange = new Set(dateRange(body.start_date, body.days));
    if (scored.some((s) => !inRange.has(s.score_date))) return await fail(400, "Ada tanggal yang sudah dinilai di luar periode baru");

    const [existing] = await conn.query(`SELECT criterion_id FROM tr_ojt_criterion WHERE ojt_id = ?`, [current.id]);
    const existingIds = new Set(existing.map((c) => c.criterion_id));
    const sameCriteria = existingIds.size === body.criterion_ids.length && body.criterion_ids.every((id) => existingIds.has(id));
    if (!sameCriteria && scored.length) return await fail(400, "Kriteria tidak bisa diubah setelah ada nilai");

    const problem = (await checkObservers(body.observer_ids)) ?? (sameCriteria ? null : await checkCriteria(body.criterion_ids));
    if (problem) return await fail(400, problem);

    const userId = req.session.employeeId;
    await conn.query(`UPDATE tr_ojt SET start_date = ?, days = ? WHERE id = ?`, [body.start_date, body.days, current.id]);
    await conn.query(`DELETE FROM tr_ojt_observer WHERE ojt_id = ?`, [current.id]);
    await insertRows(conn, "tr_ojt_observer", "employee_id", current.id, body.observer_ids, userId);
    if (!sameCriteria) {
      await conn.query(`DELETE FROM tr_ojt_criterion WHERE ojt_id = ?`, [current.id]);
      await insertRows(conn, "tr_ojt_criterion", "criterion_id", current.id, body.criterion_ids, userId);
    }
    await conn.commit();
    res.json({ message: "OJT diperbarui" });
  } catch (err) {
    await conn.rollback();
    console.error("updateOjt error:", err);
    res.status(500).json({ message: "Gagal memperbarui OJT" });
  } finally {
    conn.release();
  }
};
