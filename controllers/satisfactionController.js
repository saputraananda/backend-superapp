import pool from "../db/pool.js";

// Get current survey key (format: YYYY-MM)
function getCurrentSurveyKey() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Check if employee has already submitted survey this period
export async function checkSurveyStatus(req, res) {
  try {
    const employeeId = req.session.employeeId;
    
    if (!employeeId) {
      return res.status(401).json({ 
        message: "Employee ID not found in session" 
      });
    }

    const surveyKey = getCurrentSurveyKey();

    const [rows] = await pool.query(
      `SELECT id, full_name, submitted_at, status 
       FROM tr_employee_satisfaction_audit 
       WHERE employee_id = ? AND survey_key = ? AND status = 'COMPLETED'`,
      [employeeId, surveyKey]
    );

    res.json({
      surveyKey,
      hasSubmitted: rows.length > 0,
      submittedAt: rows[0]?.submitted_at || null,
      submittedBy: rows[0]?.full_name || null,
    });
  } catch (err) {
    console.error("Error checking survey status:", err);
    res.status(500).json({ message: "Gagal memeriksa status survei" });
  }
}

// Get master data for survey
export async function getSurveyMasterData(req, res) {
  try {
    const [companies] = await pool.query(
      `SELECT company_id, company_name FROM mst_company WHERE is_active = 1 ORDER BY company_name`
    );

    const [departments] = await pool.query(
      `SELECT department_id, department_name FROM mst_department WHERE is_active = 1 ORDER BY department_name`
    );

    // Ambil join_date semua karyawan aktif
    const [employees] = await pool.query(
      `SELECT join_date FROM mst_employee`
    );

    // Hitung masa kerja (tenure) untuk masing-masing join_date
    const now = new Date();
    const tenureSet = new Set();

    employees.forEach(emp => {
      const joinDate = new Date(emp.join_date);
      const diffMs = now - joinDate;
      const diffMonth = diffMs / (1000 * 60 * 60 * 24 * 30.44);

      let label = "";
      if (diffMonth < 3) label = "< 3 bulan";
      else if (diffMonth < 6) label = "3 - 6 bulan";
      else if (diffMonth < 12) label = "6 - 12 bulan";
      else label = "> 1 tahun";

      tenureSet.add(label);
    });

    // Buat array dan urutkan sesuai kebutuhan
    const tenureOptions = [
      { value: "< 3 bulan", label: "< 3 bulan" },
      { value: "3 - 6 bulan", label: "3 - 6 bulan" },
      { value: "6 - 12 bulan", label: "6 - 12 bulan" },
      { value: "> 1 tahun", label: "> 1 tahun" },
    ].filter(opt => tenureSet.has(opt.value));

    res.json({
      companies,
      departments,
      tenures: tenureOptions,
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

    if (!employeeId) {
      return res.status(401).json({ 
        message: "Employee ID not found in session" 
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
      full_name,
      company_name,
      department_name,
      job_level_name,
      tenure,
      overall_satisfaction,
      main_factors,
      c1, c2, c3, c4, c5, c6, c7, c8,
      c9, c10, c11, c12, c13, c14, c15, c16,
      d1, d2, d3,
    } = req.body;

    // Validate required fields
    if (!full_name || !department_name || !job_level_name || !tenure || !overall_satisfaction) {
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

    // Insert satisfaction data with employee identity
    const [result] = await connection.query(
      `INSERT INTO tr_employee_satisfaction (
        employee_id, full_name, company_name, department_name, job_level_name, tenure,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeId,
        full_name,
        company_name || null,
        department_name || null,
        job_level_name || null,
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

    // Insert audit record
    await connection.query(
      `INSERT INTO tr_employee_satisfaction_audit 
       (employee_id, full_name, survey_key, status)
       VALUES (?, ?, ?, 'COMPLETED')`,
      [employeeId, full_name, surveyKey]
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
       FROM tr_employee_satisfaction
       WHERE survey_key = ? AND status = 'COMPLETED'
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
       FROM tr_employee_satisfaction
       JOIN tr_employee_satisfaction_audit a ON tr_employee_satisfaction.employee_id = a.employee_id
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