import { safeQuery } from "../db/pool.js";

const getSurveyKey = () => process.env.BURNOUT_SURVEY_KEY || "Aloranumber1-Juli";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/analysis-burnout/verify-key — Validasi Kunci Survei sebelum mengisi
// ═══════════════════════════════════════════════════════════════════════════
export const validateKey = async (req, res) => {
  try {
    const { survey_key } = req.body;
    const employeeId = req.session.employeeId;
    if (!survey_key) {
      return res.status(400).json({ success: false, message: "Kunci survei wajib diisi" });
    }

    const correctKey = getSurveyKey();
    if (survey_key !== correctKey) {
      return res.status(400).json({ success: false, message: "Kunci survei tidak valid" });
    }

    // Cek apakah sudah pernah isi dengan kunci ini
    const [existing] = await safeQuery(
      `SELECT id FROM tr_analysis_burnout WHERE employee_id = ? AND survey_key = ? LIMIT 1`,
      [employeeId, survey_key]
    );

    if (existing.length > 0) {
      return res.json({
        success: true,
        alreadyExists: true,
        message: "Anda sudah pernah mengisi survei ini menggunakan kunci tersebut.",
      });
    }

    return res.json({ success: true, alreadyExists: false, message: "Kunci survei valid" });
  } catch (err) {
    console.error("[validateKey] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/analysis-burnout/submit — Simpan jawaban survei burnout
// ═══════════════════════════════════════════════════════════════════════════
export const submitSurvey = async (req, res) => {
  try {
    const employeeId = req.session.employeeId;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized: Employee session tidak ditemukan" });
    }

    const { survey_key, ...answers } = req.body;

    // 1. Validasi Kunci Survei & Cek Duplikat
    const correctKey = getSurveyKey();
    if (!survey_key || survey_key !== correctKey) {
      return res.status(400).json({ success: false, message: "Kunci survei tidak valid atau telah kedaluwarsa" });
    }

    const [existing] = await safeQuery(
      `SELECT id FROM tr_analysis_burnout WHERE employee_id = ? AND survey_key = ? LIMIT 1`,
      [employeeId, survey_key]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, alreadyExists: true, message: "Anda sudah pernah mengisi survei ini menggunakan kunci tersebut." });
    }

    // 2. Ambil department_id karyawan saat ini
    const [empRows] = await safeQuery(
      `SELECT department_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1`,
      [employeeId]
    );

    if (empRows.length === 0) {
      return res.status(404).json({ success: false, message: "Karyawan tidak ditemukan" });
    }
    const departmentId = empRows[0].department_id;

    // 3. Susun pertanyaan dari a1 s/d h4
    const categories = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const fields = [];
    const placeholders = [];
    const values = [employeeId, departmentId, survey_key];

    for (const cat of categories) {
      for (let i = 1; i <= 4; i++) {
        const key = `${cat}${i}`;
        const val = parseInt(answers[key], 10);
        if (isNaN(val) || val < 1 || val > 5) {
          return res.status(400).json({
            success: false,
            message: `Jawaban untuk pertanyaan ${key.toUpperCase()} tidak valid (harus skala 1-5)`,
          });
        }
        fields.push(key);
        placeholders.push("?");
        values.push(val);
      }
    }

    // 4. Jalankan Query Insert
    const insertQuery = `
      INSERT INTO tr_analysis_burnout (
        employee_id, department_id, survey_key,
        ${fields.join(", ")}
      ) VALUES (?, ?, ?, ${placeholders.join(", ")})
    `;

    await safeQuery(insertQuery, values);

    return res.json({ success: true, message: "Survei burnout berhasil disimpan. Terima kasih telah berpartisipasi!" });
  } catch (err) {
    console.error("[submitSurvey] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/analysis-burnout/history — Cek riwayat survei karyawan
// ═══════════════════════════════════════════════════════════════════════════
export const getSurveyHistory = async (req, res) => {
  try {
    const employeeId = req.session.employeeId;
    if (!employeeId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const [rows] = await safeQuery(
      `SELECT id, created_at
       FROM tr_analysis_burnout
       WHERE employee_id = ?
       ORDER BY created_at DESC`,
      [employeeId]
    );

    return res.json({
      success: true,
      history: rows,
    });
  } catch (err) {
    console.error("[getSurveyHistory] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/analysis-burnout/monitoring — monitoring jawaban per karyawan
// ═══════════════════════════════════════════════════════════════════════════
export const getBurnoutMonitoringList = async (req, res) => {
  try {


    const {
      page = 1,
      limit = 25,
      search = "",
      department_id = "",
      date_from = "",
      date_to = "",
    } = req.query;

    const p = Number(page);
    const l = Number(limit);
    const offset = (p - 1) * l;

    const conditions = ["1=1"];
    const params = [];

    if (search) {
      conditions.push("(e.full_name LIKE ? OR e.employee_code LIKE ? OR d.department_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (department_id) {
      conditions.push("t.department_id = ?");
      params.push(department_id);
    }

    if (date_from) {
      conditions.push("DATE(t.created_at) >= ?");
      params.push(date_from);
    }

    if (date_to) {
      conditions.push("DATE(t.created_at) <= ?");
      params.push(date_to);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const totalScoreExpr = `(
      t.a1+t.a2+t.a3+t.a4+
      t.b1+t.b2+t.b3+t.b4+
      t.c1+t.c2+t.c3+t.c4+
      t.d1+t.d2+t.d3+t.d4+
      t.e1+t.e2+t.e3+t.e4+
      t.f1+t.f2+t.f3+t.f4+
      t.g1+t.g2+t.g3+t.g4+
      t.h1+t.h2+t.h3+t.h4
    )`;

    const catScore = {
      A: "t.a1+t.a2+t.a3+t.a4",
      B: "t.b1+t.b2+t.b3+t.b4",
      C: "t.c1+t.c2+t.c3+t.c4",
      D: "t.d1+t.d2+t.d3+t.d4",
      E: "t.e1+t.e2+t.e3+t.e4",
      F: "t.f1+t.f2+t.f3+t.f4",
      G: "t.g1+t.g2+t.g3+t.g4",
      H: "t.h1+t.h2+t.h3+t.h4",
    };

    const dataQuery = `
      SELECT
        t.id,
        t.employee_id,
        e.full_name,
        e.employee_code,
        d.department_name,
        t.created_at,
        t.survey_key,
        t.a1, t.a2, t.a3, t.a4,
        t.b1, t.b2, t.b3, t.b4,
        t.c1, t.c2, t.c3, t.c4,
        t.d1, t.d2, t.d3, t.d4,
        t.e1, t.e2, t.e3, t.e4,
        t.f1, t.f2, t.f3, t.f4,
        t.g1, t.g2, t.g3, t.g4,
        t.h1, t.h2, t.h3, t.h4,
        ${totalScoreExpr} AS total_score,
        ${catScore.A} AS score_A,
        ${catScore.B} AS score_B,
        ${catScore.C} AS score_C,
        ${catScore.D} AS score_D,
        ${catScore.E} AS score_E,
        ${catScore.F} AS score_F,
        ${catScore.G} AS score_G,
        ${catScore.H} AS score_H
      FROM tr_analysis_burnout t
      JOIN mst_employee e ON e.employee_id = t.employee_id AND e.is_deleted = 0
      LEFT JOIN mst_department d ON d.department_id = t.department_id
      ${whereClause}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM tr_analysis_burnout t
      JOIN mst_employee e ON e.employee_id = t.employee_id AND e.is_deleted = 0
      LEFT JOIN mst_department d ON d.department_id = t.department_id
      ${whereClause}
    `;

    const [rows] = await safeQuery(dataQuery, [...params, l, offset]);
    const [[{ total }]] = await safeQuery(countQuery, params);

    return res.json({
      success: true,
      data: rows,
      pagination: {
        total: Number(total || 0),
        page: p,
        limit: l,
        totalPages: Math.ceil(Number(total || 0) / l),
      },
    });
  } catch (err) {
    console.error("[getBurnoutMonitoringList] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/analysis-burnout/monitoring/:id — detail jawaban 1 submission
// ═══════════════════════════════════════════════════════════════════════════
export const getBurnoutMonitoringDetail = async (req, res) => {
  try {


    const { id } = req.params;

    const totalScoreExpr = `(
      t.a1+t.a2+t.a3+t.a4+
      t.b1+t.b2+t.b3+t.b4+
      t.c1+t.c2+t.c3+t.c4+
      t.d1+t.d2+t.d3+t.d4+
      t.e1+t.e2+t.e3+t.e4+
      t.f1+t.f2+t.f3+t.f4+
      t.g1+t.g2+t.g3+t.g4+
      t.h1+t.h2+t.h3+t.h4
    )`;

    const catScore = {
      A: "t.a1+t.a2+t.a3+t.a4",
      B: "t.b1+t.b2+t.b3+t.b4",
      C: "t.c1+t.c2+t.c3+t.c4",
      D: "t.d1+t.d2+t.d3+t.d4",
      E: "t.e1+t.e2+t.e3+t.e4",
      F: "t.f1+t.f2+t.f3+t.f4",
      G: "t.g1+t.g2+t.g3+t.g4",
      H: "t.h1+t.h2+t.h3+t.h4",
    };

    const [rows] = await safeQuery(
      `
        SELECT
          t.*,
          e.full_name,
          e.employee_code,
          d.department_name,
          ${totalScoreExpr} AS total_score,
          ${catScore.A} AS score_A,
          ${catScore.B} AS score_B,
          ${catScore.C} AS score_C,
          ${catScore.D} AS score_D,
          ${catScore.E} AS score_E,
          ${catScore.F} AS score_F,
          ${catScore.G} AS score_G,
          ${catScore.H} AS score_H
        FROM tr_analysis_burnout t
        JOIN mst_employee e ON e.employee_id = t.employee_id AND e.is_deleted = 0
        LEFT JOIN mst_department d ON d.department_id = t.department_id
        WHERE t.id = ?
        LIMIT 1
      `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Data tidak ditemukan" });
    }

    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("[getBurnoutMonitoringDetail] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
