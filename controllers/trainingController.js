import { safeQuery } from "../db/pool.js";
import { pool } from "../db/pool.js";

// Helper checking if user is HRD based on position_id
const isHRDUser = (employee) => {
  if (!employee) return false;
  return [1, 8, 17, 18, 19].includes(Number(employee.position_id));
};

// Helper checking if user is Supervisor level (job_level_id <= 3)
const isSupervisorUser = (employee) => {
  if (!employee) return false;
  const level = Number(employee.job_level_id);
  return !Number.isNaN(level) && level <= 3;
};

// Helper to fetch employee details by id
const getEmployeeDetails = async (employeeId) => {
  const [rows] = await safeQuery(
    `SELECT e.*, jl.job_level_name, p.position_name, d.department_name
     FROM mst_employee e
     LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
     LEFT JOIN mst_position p ON e.position_id = p.position_id
     LEFT JOIN mst_department d ON e.department_id = d.department_id
     WHERE e.employee_id = ? AND e.is_deleted = 0 LIMIT 1`,
    [employeeId]
  );
  return rows[0] || null;
};

// GET all training requests (with pagination, filters, search, and permissions)
export const getRequests = async (req, res) => {
  try {
    const { page = 1, limit = 25, search = "", status = "", company_id = "", date_from = "", date_to = "", training_type = "", only_me = "" } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!currentEmp) {
      return res.status(404).json({ message: "Karyawan tidak ditemukan" });
    }

    const isHR = isHRDUser(currentEmp);
    const isSpv = isSupervisorUser(currentEmp);

    let whereClauses = ["1=1"];
    let params = [];

    // Search filter
    if (search.trim() !== "") {
      whereClauses.push("(t.topic LIKE ? OR r.full_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    // Status filter
    if (status && status.trim() !== "") {
      whereClauses.push("t.status = ?");
      params.push(status);
    }

    // Company filter
    if (company_id && company_id.trim() !== "") {
      whereClauses.push("t.company_id = ?");
      params.push(company_id);
    }

    // Training type filter
    if (training_type && training_type.trim() !== "") {
      whereClauses.push("t.training_type = ?");
      params.push(training_type);
    }

    // Date range filter
    if (date_from && date_from.trim() !== "") {
      whereClauses.push("t.request_date >= ?");
      params.push(date_from);
    }
    if (date_to && date_to.trim() !== "") {
      whereClauses.push("t.request_date <= ?");
      params.push(date_to);
    }

    // Filter to only show logged-in user's requests if requested
    if (only_me === "true") {
      whereClauses.push("t.requester_id = ?");
      params.push(currentEmpId);
    }

    const whereSql = whereClauses.join(" AND ");

    // Query main data
    const query = `
      SELECT t.*, 
             r.full_name AS requester_name, 
             d.department_name, 
             c.company_name,
             cp.full_name AS contact_person_name,
             spv.full_name AS supervisor_name,
             hr.full_name AS hrd_name
      FROM tr_training_management t
      LEFT JOIN mst_employee r ON t.requester_id = r.employee_id
      LEFT JOIN mst_department d ON t.department_id = d.department_id
      LEFT JOIN mst_company c ON t.company_id = c.company_id
      LEFT JOIN mst_employee cp ON t.contact_person_id = cp.employee_id
      LEFT JOIN mst_employee spv ON t.supervisor_id = spv.employee_id
      LEFT JOIN mst_employee hr ON t.hrd_id = hr.employee_id
      WHERE ${whereSql}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM tr_training_management t
      LEFT JOIN mst_employee r ON t.requester_id = r.employee_id
      WHERE ${whereSql}
    `;

    // Append limit and offset parameters
    const [rows] = await safeQuery(query, [...params, Number(limit), Number(offset)]);
    const [countRows] = await safeQuery(countQuery, params);
    const total = countRows[0]?.total || 0;

    res.json({
      data: rows,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit))
      }
    });
  } catch (err) {
    console.error("[getRequests] Error:", err);
    res.status(500).json({ message: "Gagal mengambil data pengajuan training", error: err.message });
  }
};

// GET training request by ID with relations
export const getRequestById = async (req, res) => {
  try {
    const { id } = req.params;
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const [rows] = await safeQuery(
      `SELECT t.*, 
              r.full_name AS requester_name, 
              d.department_name, 
              c.company_name,
              cp.full_name AS contact_person_name,
              spv.full_name AS supervisor_name,
              hr.full_name AS hrd_name
       FROM tr_training_management t
       LEFT JOIN mst_employee r ON t.requester_id = r.employee_id
       LEFT JOIN mst_department d ON t.department_id = d.department_id
       LEFT JOIN mst_company c ON t.company_id = c.company_id
       LEFT JOIN mst_employee cp ON t.contact_person_id = cp.employee_id
       LEFT JOIN mst_employee spv ON t.supervisor_id = spv.employee_id
       LEFT JOIN mst_employee hr ON t.hrd_id = hr.employee_id
       WHERE t.id = ? LIMIT 1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan training tidak ditemukan" });
    }

    const training = rows[0];

    // Fetch mentors
    const [mentors] = await safeQuery(
      `SELECT m.employee_id, e.full_name, e.employee_code 
       FROM tr_training_mentors m
       JOIN mst_employee e ON m.employee_id = e.employee_id
       WHERE m.training_id = ?`,
      [id]
    );

    // Fetch trainees
    const [trainees] = await safeQuery(
      `SELECT t.employee_id, e.full_name, e.employee_code 
       FROM tr_training_trainees t
       JOIN mst_employee e ON t.employee_id = e.employee_id
       WHERE t.training_id = ?`,
      [id]
    );

    // Fetch vendors
    const [vendors] = await safeQuery(
      `SELECT tv.id, tv.vendor_id, tv.vendor_name, mv.nama_vendor
       FROM tr_training_vendors tv
       LEFT JOIN mst_vendor mv ON tv.vendor_id = mv.id
       WHERE tv.training_id = ?`,
      [id]
    );

    res.json({
      training,
      mentors,
      trainees,
      vendors
    });
  } catch (err) {
    console.error("[getRequestById] Error:", err);
    res.status(500).json({ message: "Gagal mengambil detail pengajuan training", error: err.message });
  }
};

// CREATE training request
export const createRequest = async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      requester_id,
      department_id,
      request_date,
      topic,
      company_id,
      training_type,
      training_method,
      reasons_and_impact,
      current_competency,
      target_competency,
      training_target,
      priority_material,
      contact_person_id,
      supervisor_id,
      mentors = [],  // Array of employee_id
      trainees = [],  // Array of employee_id
      vendors = []    // Array of { vendor_id, vendor_name }
    } = req.body;

    if (!requester_id || !department_id || !topic || !company_id || !training_type || !training_method || !reasons_and_impact || !current_competency || !target_competency || !training_target || !priority_material || trainees.length === 0) {
      return res.status(400).json({ message: "Semua kolom utama wajib diisi dan minimal 1 karyawan ditraining" });
    }

    // Determine initial status based on requester's job level
    const requester = await getEmployeeDetails(requester_id);
    if (!requester) {
      return res.status(404).json({ message: "Karyawan pengaju tidak ditemukan" });
    }

    const jobLevel = Number(requester.job_level_id);
    // Staff is 4, require Supervisor approval first
    // Supervisor (3), Manager (2), Director (1) go directly to HRD
    const requireSupervisor = jobLevel === 4;
    const initialStatus = requireSupervisor ? "Pending_Supervisor" : "Pending_HRD";

    // Insert main training record
    const [result] = await connection.query(
      `INSERT INTO tr_training_management (
        requester_id, department_id, request_date, topic, company_id, 
        training_type, training_method, reasons_and_impact, 
        current_competency, target_competency, training_target, 
        priority_material, contact_person_id, supervisor_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requester_id,
        department_id,
        request_date || new Date().toISOString().split("T")[0],
        topic,
        company_id,
        training_type,
        training_method,
        reasons_and_impact,
        current_competency,
        target_competency,
        training_target,
        priority_material,
        contact_person_id || null,
        null, // supervisor_id set upon approval
        initialStatus
      ]
    );

    const trainingId = result.insertId;

    // Insert trainees
    for (const traineeId of trainees) {
      await connection.query(
        "INSERT INTO tr_training_trainees (training_id, employee_id) VALUES (?, ?)",
        [trainingId, traineeId]
      );
    }

    // Insert mentors if Internal
    if (training_method === "Internal" && mentors && mentors.length > 0) {
      for (const mentorId of mentors) {
        if (mentorId) {
          await connection.query(
            "INSERT INTO tr_training_mentors (training_id, employee_id) VALUES (?, ?)",
            [trainingId, mentorId]
          );
        }
      }
    }

    // Insert vendors if External
    if (training_method === "Eksternal" && vendors && vendors.length > 0) {
      for (const v of vendors) {
        if (v) {
          await connection.query(
            "INSERT INTO tr_training_vendors (training_id, vendor_id, vendor_name) VALUES (?, ?, ?)",
            [trainingId, v.vendor_id || null, v.vendor_name || null]
          );
        }
      }
    }

    await connection.commit();
    notifyUpdate("update", null);
    res.status(201).json({ message: "Pengajuan training berhasil dibuat", trainingId });
  } catch (err) {
    await connection.rollback();
    console.error("[createRequest] Error:", err);
    res.status(500).json({ message: "Gagal membuat pengajuan training", error: err.message });
  } finally {
    connection.release();
  }
};

// UPDATE training request (with full parameters edit)
export const updateRequest = async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const currentEmpId = req.session.employeeId;
    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    const isHR = isHRDUser(currentEmp);

    // Fetch existing request
    const [existing] = await connection.query(
      "SELECT * FROM tr_training_management WHERE id = ? LIMIT 1",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ message: "Pengajuan training tidak ditemukan" });
    }

    const training = existing[0];

    // Staff/Supervisor can only edit if status is draft or pending supervisor or rejected
    if (!isHR && training.requester_id !== currentEmpId) {
      return res.status(403).json({ message: "Anda tidak memiliki hak akses untuk mengubah pengajuan ini" });
    }

    if (!isHR && !["Pending_Supervisor", "Rejected_Supervisor", "Rejected_HRD"].includes(training.status)) {
      return res.status(400).json({ message: "Pengajuan yang sedang berjalan atau sudah disetujui tidak dapat diubah" });
    }

    const {
      requester_id,
      department_id,
      request_date,
      topic,
      company_id,
      training_type,
      training_method,
      reasons_and_impact,
      current_competency,
      target_competency,
      training_target,
      priority_material,
      contact_person_id,
      supervisor_id,
      status, // HRD can update status directly
      mentors = [],
      trainees = [],
      vendors = []
    } = req.body;

    if (!requester_id || !department_id || !topic || !company_id || !training_type || !training_method || !reasons_and_impact || !current_competency || !target_competency || !training_target || !priority_material || trainees.length === 0) {
      return res.status(400).json({ message: "Semua kolom utama wajib diisi dan minimal 1 karyawan ditraining" });
    }

    // Determine target status
    let finalStatus = training.status;
    if (isHR && status) {
      finalStatus = status;
    } else if (!isHR && ["Rejected_Supervisor", "Rejected_HRD"].includes(training.status)) {
      // Re-submit flow
      const requester = await getEmployeeDetails(requester_id);
      const isRequesterStaff = Number(requester?.job_level_id) === 4;
      finalStatus = isRequesterStaff ? "Pending_Supervisor" : "Pending_HRD";
    }

    // Update main request table
    await connection.query(
      `UPDATE tr_training_management SET
        requester_id = ?, department_id = ?, request_date = ?, topic = ?, 
        company_id = ?, training_type = ?, training_method = ?, reasons_and_impact = ?, 
        current_competency = ?, target_competency = ?, training_target = ?, 
        priority_material = ?, contact_person_id = ?, supervisor_id = ?, status = ?
       WHERE id = ?`,
      [
        requester_id,
        department_id,
        request_date,
        topic,
        company_id,
        training_type,
        training_method,
        reasons_and_impact,
        current_competency,
        target_competency,
        training_target,
        priority_material,
        contact_person_id || null,
        training.supervisor_id,
        finalStatus,
        id
      ]
    );

    // Update trainees (delete and insert)
    await connection.query("DELETE FROM tr_training_trainees WHERE training_id = ?", [id]);
    for (const traineeId of trainees) {
      await connection.query(
        "INSERT INTO tr_training_trainees (training_id, employee_id) VALUES (?, ?)",
        [id, traineeId]
      );
    }

    // Update mentors (delete and insert if Internal)
    await connection.query("DELETE FROM tr_training_mentors WHERE training_id = ?", [id]);
    if (training_method === "Internal" && mentors && mentors.length > 0) {
      for (const mentorId of mentors) {
        if (mentorId) {
          await connection.query(
            "INSERT INTO tr_training_mentors (training_id, employee_id) VALUES (?, ?)",
            [id, mentorId]
          );
        }
      }
    }

    // Update vendors (delete and insert if External)
    await connection.query("DELETE FROM tr_training_vendors WHERE training_id = ?", [id]);
    if (training_method === "Eksternal" && vendors && vendors.length > 0) {
      for (const v of vendors) {
        if (v) {
          await connection.query(
            "INSERT INTO tr_training_vendors (training_id, vendor_id, vendor_name) VALUES (?, ?, ?)",
            [id, v.vendor_id || null, v.vendor_name || null]
          );
        }
      }
    }

    await connection.commit();
    notifyUpdate("update", null);
    res.json({ message: "Pengajuan training berhasil diperbarui" });
  } catch (err) {
    await connection.rollback();
    console.error("[updateRequest] Error:", err);
    res.status(500).json({ message: "Gagal memperbarui pengajuan training", error: err.message });
  } finally {
    connection.release();
  }
};

// DELETE training request
export const deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    const isHR = isHRDUser(currentEmp);

    // Fetch request
    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan training tidak ditemukan" });
    }

    const training = rows[0];

    // Check permissions: only requester (if pending supervisor/rejected) or HRD can delete
    if (!isHR) {
      if (training.requester_id !== currentEmpId) {
        return res.status(403).json({ message: "Anda tidak memiliki hak akses untuk menghapus pengajuan ini" });
      }
      if (!["Pending_Supervisor", "Rejected_Supervisor", "Rejected_HRD"].includes(training.status)) {
        return res.status(400).json({ message: "Pengajuan yang sedang diproses tidak dapat dihapus" });
      }
    }

    await safeQuery("DELETE FROM tr_training_management WHERE id = ?", [id]);
    notifyUpdate("update", null);
    res.json({ message: "Pengajuan training berhasil dihapus" });
  } catch (err) {
    console.error("[deleteRequest] Error:", err);
    res.status(500).json({ message: "Gagal menghapus pengajuan training", error: err.message });
  }
};

// SUPERVISOR: Approve request
export const approveSupervisor = async (req, res) => {
  try {
    const { id } = req.params;
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isSupervisorUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya supervisor yang dapat memberikan persetujuan" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (training.status !== "Pending_Supervisor") {
      return res.status(400).json({ message: "Status pengajuan tidak valid untuk persetujuan supervisor" });
    }

    if (Number(currentEmp.department_id) !== Number(training.department_id)) {
      return res.status(403).json({ message: "Anda hanya dapat menyetujui pengajuan dari departemen Anda sendiri" });
    }

    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Pending_HRD',
        supervisor_id = ?,
        supervisor_approved_at = CURRENT_TIMESTAMP,
        supervisor_rejection_reason = NULL
       WHERE id = ?`,
      [currentEmpId, id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Persetujuan supervisor berhasil disimpan. Status diteruskan ke HRD." });
  } catch (err) {
    console.error("[approveSupervisor] Error:", err);
    res.status(500).json({ message: "Gagal melakukan approval supervisor", error: err.message });
  }
};

// SUPERVISOR: Reject request
export const rejectSupervisor = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const currentEmpId = req.session.employeeId;

    if (!reason || reason.trim() === "") {
      return res.status(400).json({ message: "Alasan penolakan wajib diisi" });
    }

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isSupervisorUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya supervisor yang dapat menolak pengajuan" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (training.status !== "Pending_Supervisor") {
      return res.status(400).json({ message: "Status pengajuan tidak valid untuk ditolak oleh supervisor" });
    }

    if (Number(currentEmp.department_id) !== Number(training.department_id)) {
      return res.status(403).json({ message: "Anda hanya dapat menolak pengajuan dari departemen Anda sendiri" });
    }

    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Rejected_Supervisor',
        supervisor_id = ?,
        supervisor_rejection_reason = ?,
        supervisor_approved_at = NULL
       WHERE id = ?`,
      [currentEmpId, reason, id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Pengajuan berhasil ditolak oleh supervisor" });
  } catch (err) {
    console.error("[rejectSupervisor] Error:", err);
    res.status(500).json({ message: "Gagal melakukan penolakan supervisor", error: err.message });
  }
};

// HRD: Approve request (move to Pending_HRD or Review status)
export const approveHRD = async (req, res) => {
  try {
    const { id } = req.params;
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isHRDUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya HRD yang dapat melakukan tindakan ini" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (!["Pending_HRD", "Review"].includes(training.status)) {
      return res.status(400).json({ message: "Status pengajuan tidak valid untuk persetujuan HRD" });
    }

    // HRD can set status to Review or direct Approve (or schedule)
    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Review',
        hrd_id = ?,
        hrd_approved_at = CURRENT_TIMESTAMP,
        hrd_rejection_reason = NULL
       WHERE id = ?`,
      [currentEmpId, id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Status pengajuan berhasil diubah menjadi Dalam Proses Review oleh HRD" });
  } catch (err) {
    console.error("[approveHRD] Error:", err);
    res.status(500).json({ message: "Gagal melakukan approval HRD", error: err.message });
  }
};

// HRD: Reject request
export const rejectHRD = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const currentEmpId = req.session.employeeId;

    if (!reason || reason.trim() === "") {
      return res.status(400).json({ message: "Alasan penolakan wajib diisi" });
    }

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isHRDUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya HRD yang dapat melakukan tindakan ini" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (!["Pending_HRD", "Review", "Scheduled"].includes(training.status)) {
      return res.status(400).json({ message: "Status pengajuan tidak valid untuk ditolak oleh HRD" });
    }

    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Rejected_HRD',
        hrd_id = ?,
        hrd_rejection_reason = ?,
        hrd_approved_at = NULL
       WHERE id = ?`,
      [currentEmpId, reason, id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Pengajuan berhasil ditolak oleh HRD" });
  } catch (err) {
    console.error("[rejectHRD] Error:", err);
    res.status(500).json({ message: "Gagal melakukan penolakan HRD", error: err.message });
  }
};

// HRD: Schedule training
export const scheduleHRD = async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_date } = req.body;
    const currentEmpId = req.session.employeeId;

    if (!scheduled_date) {
      return res.status(400).json({ message: "Tanggal pelaksanaan wajib diisi" });
    }

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isHRDUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya HRD yang dapat menjadwalkan training" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (!["Pending_HRD", "Review", "Scheduled"].includes(training.status)) {
      return res.status(400).json({ message: "Status pengajuan tidak valid untuk dijadwalkan oleh HRD" });
    }

    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Scheduled',
        hrd_id = ?,
        scheduled_date = ?
       WHERE id = ?`,
      [currentEmpId, scheduled_date, id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Training berhasil dijadwalkan. Status diperbarui menjadi Telah Dijadwalkan." });
  } catch (err) {
    console.error("[scheduleHRD] Error:", err);
    res.status(500).json({ message: "Gagal menjadwalkan training", error: err.message });
  }
};

// HRD: Complete training (upload evidence)
export const completeHRD = async (req, res) => {
  try {
    const { id } = req.params;
    const currentEmpId = req.session.employeeId;

    if (!currentEmpId) {
      return res.status(400).json({ message: "Sesi karyawan tidak valid" });
    }

    const currentEmp = await getEmployeeDetails(currentEmpId);
    if (!isHRDUser(currentEmp)) {
      return res.status(403).json({ message: "Hanya HRD yang dapat menyelesaikan training" });
    }

    const [rows] = await safeQuery("SELECT * FROM tr_training_management WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
    }

    const training = rows[0];
    if (training.status !== "Scheduled") {
      return res.status(400).json({ message: "Hanya training berstatus Telah Dijadwalkan yang dapat diselesaikan" });
    }

    // Get files uploaded via multer
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ message: "Minimal harus mengunggah 1 bukti dokumen atau foto" });
    }

    // Store filenames as JSON array
    const filePaths = files.map((file) => `training_evidence/${file.filename}`);

    await safeQuery(
      `UPDATE tr_training_management SET
        status = 'Selesai',
        hrd_id = ?,
        evidence_files = ?
       WHERE id = ?`,
      [currentEmpId, JSON.stringify(filePaths), id]
    );

    notifyUpdate("update", null);
    res.json({ message: "Training berhasil diselesaikan dengan bukti acara diunggah.", files: filePaths });
  } catch (err) {
    console.error("[completeHRD] Error:", err);
    res.status(500).json({ message: "Gagal menyelesaikan training", error: err.message });
  }
};

// SERVER-SENT EVENTS (SSE) Active Connection Pool
let sseClients = [];

export const trainingEvents = (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Flush headers
  res.write(":\n\n");

  sseClients.push(res);

  req.on("close", () => {
    sseClients = sseClients.filter((client) => client !== res);
  });
};

export const notifyUpdate = (type, data) => {
  const payload = JSON.stringify({ type, data });
  sseClients.forEach((client) => {
    client.write(`data: ${payload}\n\n`);
  });
};

