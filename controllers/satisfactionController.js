import pool from "../db/pool.js";

// Get current survey key (format: YYYY-Q1/Q2/Q3/Q4)
function getCurrentSurveyKey() {
  const now = new Date();
  const year = now.getFullYear();
  const quarter = Math.ceil((now.getMonth() + 1) / 3);
  return `${year}-Q${quarter}`;
}

// Check if employee has already submitted survey this period
export async function checkSurveyStatus(req, res) {
  try {
    console.log("checkSurveyStatus - Session:", req.session);
    
    const employeeId = req.session.employeeId;
    
    if (!employeeId) {
      return res.status(401).json({ 
        message: "Employee ID not found in session. Please ensure you have a complete employee profile." 
      });
    }

    const surveyKey = getCurrentSurveyKey();
    console.log("Survey key:", surveyKey, "Employee ID:", employeeId);

    const [rows] = await pool.query(
      `SELECT id, submitted_at, status 
       FROM tr_employee_satisfaction_audit 
       WHERE employee_id = ? AND survey_key = ? AND status = 'COMPLETED'`,
      [employeeId, surveyKey]
    );

    res.json({
      surveyKey,
      hasSubmitted: rows.length > 0,
      submittedAt: rows[0]?.submitted_at || null,
    });
  } catch (err) {
    console.error("Error checking survey status:", err);
    res.status(500).json({ message: "Gagal memeriksa status survei" });
  }
}

// Get master data for survey
export async function getSurveyMasterData(req, res) {
  try {
    console.log("getSurveyMasterData - Session:", req.session);

    const [companies] = await pool.query(
      `SELECT company_id, company_name FROM mst_company WHERE is_active = 1 ORDER BY company_name`
    );

    const [departments] = await pool.query(
      `SELECT department_id, department_name FROM mst_department WHERE is_active = 1 ORDER BY department_name`
    );

    console.log("Master data fetched - Companies:", companies.length, "Departments:", departments.length);

    res.json({
      companies,
      departments,
      jobLevels: [
        { value: "Staff", label: "Staff" },
        { value: "SPV", label: "Supervisor" },
        { value: "Manager", label: "Manager" },
        { value: "Lainnya", label: "Lainnya" },
      ],
      tenures: [
        { value: "< 3 Bulan", label: "< 3 Bulan" },
        { value: "3-6 Bulan", label: "3–6 Bulan" },
        { value: "6-12 Bulan", label: "6–12 Bulan" },
        { value: "> 1 Tahun", label: "> 1 Tahun" },
      ],
      satisfactionLevels: [
        { value: "Sangat Puas", label: "Sangat Puas" },
        { value: "Puas", label: "Puas" },
        { value: "Netral", label: "Netral" },
        { value: "Kurang Puas", label: "Kurang Puas" },
        { value: "Sangat Tidak Puas", label: "Sangat Tidak Puas" },
      ],
      mainFactors: [
        { value: "Gaji & kompensasi", label: "Gaji & kompensasi" },
        { value: "Tunjangan & fasilitas", label: "Tunjangan & fasilitas" },
        { value: "Beban kerja", label: "Beban kerja" },
        { value: "Lingkungan kerja", label: "Lingkungan kerja" },
        { value: "Atasan langsung", label: "Atasan langsung" },
        { value: "Kebijakan manajemen", label: "Kebijakan manajemen" },
        { value: "Peluang pengembangan karier", label: "Peluang pengembangan karier" },
      ],
    });
  } catch (err) {
    console.error("Error getting survey master data:", err);
    res.status(500).json({ message: "Gagal memuat data master", error: err.message });
  }
}

// Submit survey
export async function submitSurvey(req, res) {
  const connection = await pool.getConnection();

  try {
    const employeeId = req.session.employeeId;
    const email = req.session.userEmail;

    console.log("submitSurvey - Employee ID:", employeeId, "Email:", email);

    if (!employeeId || !email) {
      return res.status(401).json({ 
        message: "Employee ID or email not found in session" 
      });
    }

    const surveyKey = getCurrentSurveyKey();

    // Check if already submitted
    const [existing] = await connection.query(
      `SELECT id FROM tr_employee_satisfaction_audit 
       WHERE employee_id = ? AND survey_key = ? AND status = 'COMPLETED'`,
      [employeeId, surveyKey]
    );

    if (existing.length > 0) {
      return res.status(400).json({
        message: "Anda sudah mengisi survei untuk periode ini",
      });
    }

    const {
      company_id,
      department_text,
      job_level,
      tenure,
      overall_satisfaction,
      main_factors,
      c1, c2, c3, c4, c5, c6, c7, c8,
      c9, c10, c11, c12, c13, c14, c15, c16,
      d1, d2, d3,
    } = req.body;

    // Validate required fields
    if (!department_text || !job_level || !tenure || !overall_satisfaction) {
      return res.status(400).json({
        message: "Mohon lengkapi semua informasi umum dan kepuasan kerja",
      });
    }

    // Validate likert scale fields (c1-c16)
    const likertFields = [c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16];
    for (let i = 0; i < likertFields.length; i++) {
      if (likertFields[i] !== null && likertFields[i] !== undefined) {
        const val = parseInt(likertFields[i]);
        if (isNaN(val) || val < 1 || val > 5) {
          return res.status(400).json({
            message: `Nilai penilaian aspek kerja harus antara 1-5`,
          });
        }
      }
    }

    await connection.beginTransaction();

    // Insert satisfaction data (anonymous)
    const [result] = await connection.query(
      `INSERT INTO tr_employee_satisfaction (
        company_id, department_text, job_level, tenure,
        overall_satisfaction, main_factors,
        c1_semangat_mulai_hari, c2_pekerjaan_bermakna,
        c3_berenergi_antusias, c4_fokus_terlibat,
        c5_bangga_pekerjaan, c6_gaji_sesuai_kontribusi,
        c7_tunjangan_mendukung, c8_lingkungan_nyaman,
        c9_rekan_kerja_suportif, c10_atasan_arahan_dukung,
        c11_peluang_berkembang_belajar, c12_keterikatan_emosional,
        c13_bangga_bagian_perusahaan, c14_perusahaan_berarti,
        c15_ingin_tetap_bekerja, c16_tanggungjawab_berkontribusi,
        d1_kurang_nyaman_atau_capek, d2_bikin_betah_senang_termotivasi,
        d3_yang_perlu_dibenahi_cepat
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        company_id || null,
        department_text,
        job_level,
        tenure,
        overall_satisfaction,
        JSON.stringify(main_factors || []),
        c1 || null, c2 || null, c3 || null, c4 || null,
        c5 || null, c6 || null, c7 || null, c8 || null,
        c9 || null, c10 || null, c11 || null, c12 || null,
        c13 || null, c14 || null, c15 || null, c16 || null,
        d1 || null, d2 || null, d3 || null,
      ]
    );

    const satisfactionId = result.insertId;

    // Insert audit record
    await connection.query(
      `INSERT INTO tr_employee_satisfaction_audit 
       (employee_id, email, survey_key, satisfaction_id, status)
       VALUES (?, ?, ?, ?, 'COMPLETED')`,
      [employeeId, email, surveyKey, satisfactionId]
    );

    await connection.commit();

    res.json({
      message: "Terima kasih! Survei berhasil dikirim.",
      surveyKey,
    });
  } catch (err) {
    await connection.rollback();
    console.error("Error submitting survey:", err);
    res.status(500).json({ message: "Gagal menyimpan survei" });
  } finally {
    connection.release();
  }
}

// Get survey statistics (for admin/HR)
export async function getSurveyStats(req, res) {
  try {
    const surveyKey = req.query.survey_key || getCurrentSurveyKey();

    // Get total submissions
    const [totalRows] = await pool.query(
      `SELECT COUNT(*) as total FROM tr_employee_satisfaction_audit 
       WHERE survey_key = ? AND status = 'COMPLETED'`,
      [surveyKey]
    );

    // Get satisfaction distribution
    const [satisfactionDist] = await pool.query(
      `SELECT overall_satisfaction, COUNT(*) as count 
       FROM tr_employee_satisfaction s
       JOIN tr_employee_satisfaction_audit a ON s.id = a.satisfaction_id
       WHERE a.survey_key = ? AND a.status = 'COMPLETED'
       GROUP BY overall_satisfaction`,
      [surveyKey]
    );

    // Get average scores for C1-C16
    const [avgScores] = await pool.query(
      `SELECT 
        AVG(c1_semangat_mulai_hari) as c1,
        AVG(c2_pekerjaan_bermakna) as c2,
        AVG(c3_berenergi_antusias) as c3,
        AVG(c4_fokus_terlibat) as c4,
        AVG(c5_bangga_pekerjaan) as c5,
        AVG(c6_gaji_sesuai_kontribusi) as c6,
        AVG(c7_tunjangan_mendukung) as c7,
        AVG(c8_lingkungan_nyaman) as c8,
        AVG(c9_rekan_kerja_suportif) as c9,
        AVG(c10_atasan_arahan_dukung) as c10,
        AVG(c11_peluang_berkembang_belajar) as c11,
        AVG(c12_keterikatan_emosional) as c12,
        AVG(c13_bangga_bagian_perusahaan) as c13,
        AVG(c14_perusahaan_berarti) as c14,
        AVG(c15_ingin_tetap_bekerja) as c15,
        AVG(c16_tanggungjawab_berkontribusi) as c16
       FROM tr_employee_satisfaction s
       JOIN tr_employee_satisfaction_audit a ON s.id = a.satisfaction_id
       WHERE a.survey_key = ? AND a.status = 'COMPLETED'`,
      [surveyKey]
    );

    res.json({
      surveyKey,
      totalSubmissions: totalRows[0]?.total || 0,
      satisfactionDistribution: satisfactionDist,
      averageScores: avgScores[0] || {},
    });
  } catch (err) {
    console.error("Error getting survey stats:", err);
    res.status(500).json({ message: "Gagal memuat statistik" });
  }
}