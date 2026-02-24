// src/controllers/pmController.js
import { pool, safeQuery } from "../db/pool.js";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const EVIDENCE_URL_PREFIX = "/assets/evidence";
const EVIDENCE_DISK_DIR   = path.join(__dirname, "..", "assets", "evidence");

// ─── Job Level Constants (sesuai DB) ──────────────────────────────────────────
const JOB_LEVEL = {
  DIREKTUR:   1,   // bisa semua
  SUPERVISOR: 2,   // bisa create semester, monthly, task + set assignees
  STAFF:      3,   // hanya bisa create task (self PIC only)
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getSessionEmployee(req) {
  if (!req.session?.employeeId) return null;
  const [rows] = await safeQuery(
    `SELECT employee_id, full_name, email, job_level_id
     FROM mst_employee
     WHERE employee_id = ? AND is_deleted = 0
     LIMIT 1`,
    [req.session.employeeId]
  );
  return rows[0] || null;
}

function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  if (!req.session?.employeeId) {
    res.status(403).json({ message: "Employee session not found" });
    return false;
  }
  return true;
}

// Semakin kecil angka = semakin tinggi level (1=Direktur, 2=Supervisor, 3=Staff)
// "minLevel" artinya: job_level_id harus <= angka ini
function requireMinJobLevel(employee, maxLevelId) {
  return Number(employee?.job_level_id || 99) <= Number(maxLevelId);
}

// Shorthand helpers
function isDirektur(employee)   { return Number(employee?.job_level_id) === JOB_LEVEL.DIREKTUR; }
function isSupervisorUp(employee) { return requireMinJobLevel(employee, JOB_LEVEL.SUPERVISOR); } // level 1 & 2
function isStaffUp(employee)    { return requireMinJobLevel(employee, JOB_LEVEL.STAFF); }       // semua level

// ─── PROJECT ──────────────────────────────────────────────────────────────────
export async function listProjects(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const [rows] = await safeQuery(
      `SELECT p.id, p.title, p.\`desc\`,
              p.requestor_employee_id, p.created_at, p.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_project p
       LEFT JOIN mst_employee e ON e.employee_id = p.requestor_employee_id AND e.is_deleted = 0
       ORDER BY p.created_at DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listProjects error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function createProject(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);

    // ✅ Hanya Direktur (level 1) yang bisa buat annual project
    if (!isDirektur(employee)) {
      return res.status(403).json({ message: "Hanya Direktur yang bisa membuat annual project" });
    }

    const { title, desc } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "title is required" });

    const [result] = await safeQuery(
      `INSERT INTO tr_pm_project (title, \`desc\`, requestor_employee_id) VALUES (?, ?, ?)`,
      [title.trim(), desc || null, employee.employee_id]
    );
    res.status(201).json({ message: "Project created", id: result.insertId });
  } catch (err) {
    console.error("createProject error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function getProjectDetail(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { projectId } = req.params;
    const [[project]] = await safeQuery(
      `SELECT p.id, p.title, p.\`desc\`,
              p.requestor_employee_id, p.created_at, p.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_project p
       LEFT JOIN mst_employee e ON e.employee_id = p.requestor_employee_id AND e.is_deleted = 0
       WHERE p.id = ? LIMIT 1`,
      [projectId]
    );
    if (!project) return res.status(404).json({ message: "Project not found" });

    const [semesters] = await safeQuery(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, s.created_at, s.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON e.employee_id = s.requestor_employee_id AND e.is_deleted = 0
       WHERE s.id_project = ?
       ORDER BY s.semester ASC, s.created_at DESC`,
      [projectId]
    );
    res.json({ project, semesters });
  } catch (err) {
    console.error("getProjectDetail error:", err);
    res.status(500).json({ message: err.message });
  }
}

// ─── SEMESTER ─────────────────────────────────────────────────────────────────
export async function createSemester(req, res) {
  const conn = await pool.getConnection();
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);

    //  Direktur (1) & Supervisor (2) bisa buat semester
    if (!isSupervisorUp(employee)) {
      return res.status(403).json({ message: "Hanya Supervisor+ yang bisa membuat semester project" });
    }

    const { projectId } = req.params;
    const { semester, title, desc } = req.body;
    const sem = Number(semester);
    if (![1, 2].includes(sem))  return res.status(400).json({ message: "semester must be 1 or 2" });
    if (!title?.trim())          return res.status(400).json({ message: "title is required" });

    await conn.beginTransaction();
    const [[exists]] = await conn.query(
      `SELECT COUNT(*) AS cnt FROM tr_pm_semester
       WHERE id_project = ? AND semester = ? AND requestor_employee_id = ?`,
      [projectId, sem, employee.employee_id]
    );
    if (exists.cnt >= 1) {
      await conn.rollback();
      return res.status(409).json({ message: "Anda sudah membuat semester ini untuk project ini" });
    }
    const [ins] = await conn.query(
      `INSERT INTO tr_pm_semester (id_project, semester, title, \`desc\`, requestor_employee_id)
       VALUES (?, ?, ?, ?, ?)`,
      [projectId, sem, title.trim(), desc || null, employee.employee_id]
    );
    await conn.commit();
    res.status(201).json({ message: "Semester created", id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    console.error("createSemester error:", err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
}

export async function listSemesters(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { projectId } = req.params;
    const [rows] = await safeQuery(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, s.created_at, s.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON e.employee_id = s.requestor_employee_id AND e.is_deleted = 0
       WHERE s.id_project = ?
       ORDER BY s.semester ASC, s.created_at DESC`,
      [projectId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listSemesters error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function getSemesterDetail(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { semesterId } = req.params;
    const [[semester]] = await safeQuery(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, s.created_at, s.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON e.employee_id = s.requestor_employee_id AND e.is_deleted = 0
       WHERE s.id = ? LIMIT 1`,
      [semesterId]
    );
    if (!semester) return res.status(404).json({ message: "Semester not found" });
    res.json({ data: semester });
  } catch (err) {
    console.error("getSemesterDetail error:", err);
    res.status(500).json({ message: err.message });
  }
}

// ─── MONTHLY ──────────────────────────────────────────────────────────────────
export async function createMonthly(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);

    // ✅ Direktur (1) & Supervisor (2) bisa buat monthly
    if (!isSupervisorUp(employee)) {
      return res.status(403).json({ message: "Hanya Supervisor+ yang bisa membuat monthly project" });
    }

    const { semesterId } = req.params;
    const { projectId, month, title, desc } = req.body;
    const m = Number(month);
    if (!(m >= 1 && m <= 12)) return res.status(400).json({ message: "month must be 1..12" });
    if (!title?.trim())        return res.status(400).json({ message: "title is required" });
    if (!projectId)            return res.status(400).json({ message: "projectId is required" });

    const [[sem]] = await safeQuery(
      `SELECT id, id_project, semester FROM tr_pm_semester WHERE id = ? LIMIT 1`,
      [semesterId]
    );
    if (!sem) return res.status(404).json({ message: "Semester not found" });

    const [ins] = await safeQuery(
      `INSERT INTO tr_pm_monthly (id_project, id_semester, \`month\`, title, \`desc\`, requestor_employee_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, semesterId, m, title.trim(), desc || null, employee.employee_id]
    );
    res.status(201).json({ message: "Monthly created", id: ins.insertId });
  } catch (err) {
    console.error("createMonthly error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function listMonthlyBySemester(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { semesterId } = req.params;
    const [rows] = await safeQuery(
      `SELECT m.id, m.id_project, m.id_semester, m.\`month\`, m.title, m.\`desc\`,
              m.requestor_employee_id, m.created_at, m.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_monthly m
       LEFT JOIN mst_employee e ON e.employee_id = m.requestor_employee_id AND e.is_deleted = 0
       WHERE m.id_semester = ?
       ORDER BY m.\`month\` ASC`,
      [semesterId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listMonthlyBySemester error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function getMonthlyDetail(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { monthlyId } = req.params;
    const [[monthly]] = await safeQuery(
      `SELECT m.id, m.id_semester, m.month, m.title, m.\`desc\`,
              m.requestor_employee_id, m.created_at, m.updated_at,
              e.full_name AS requestor_name
       FROM tr_pm_monthly m
       LEFT JOIN mst_employee e ON e.employee_id = m.requestor_employee_id AND e.is_deleted = 0
       WHERE m.id = ? LIMIT 1`,
      [monthlyId]
    );
    if (!monthly) return res.status(404).json({ message: "Monthly not found" });

    const [tasks] = await safeQuery(
      `SELECT
         t.id, t.id_monthly, t.title, t.\`desc\`, t.status, t.priority,
         t.startdate, t.enddate, t.evidance, t.evidance_path,
         t.owner_employee_id, t.pic_employee_id, t.created_at, t.updated_at,
         owner.full_name AS owner_name, owner.email AS owner_email,
         pic.full_name   AS pic_name,   pic.email   AS pic_email
       FROM tr_pm_task t
       LEFT JOIN mst_employee owner ON owner.employee_id = t.owner_employee_id AND owner.is_deleted = 0
       LEFT JOIN mst_employee pic   ON pic.employee_id   = t.pic_employee_id   AND pic.is_deleted   = 0
       WHERE t.id_monthly = ?
       ORDER BY t.created_at ASC`,
      [monthlyId]
    );

    const taskIds = tasks.map((t) => t.id);
    let evidenceMap = {};
    if (taskIds.length) {
      const [evRows] = await safeQuery(
        `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_by, created_at
         FROM tr_pm_task_evidence
         WHERE task_id IN (?)
         ORDER BY created_at ASC`,
        [taskIds]
      );
      for (const ev of evRows) {
        if (!evidenceMap[ev.task_id]) evidenceMap[ev.task_id] = [];
        evidenceMap[ev.task_id].push(ev);
      }
    }

    res.json({
      monthly,
      tasks: tasks.map((t) => ({ ...t, evidence_files: evidenceMap[t.id] || [] })),
    });
  } catch (err) {
    console.error("getMonthlyDetail error:", err);
    res.status(500).json({ message: err.message });
  }
}

// ─── TASKS ────────────────────────────────────────────────────────────────────
export async function createTask(req, res) {
  const conn = await pool.getConnection();
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);

    // ✅ Semua level bisa buat task
    if (!employee) {
      return res.status(403).json({ message: "Employee tidak ditemukan" });
    }

    const { monthlyId } = req.params;
    const { title, desc, startdate, enddate, status, priority, pic_employee_id, evidance, assignees } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "title is required" });

    await conn.beginTransaction();

    let picId = pic_employee_id ?? null;

    // ✅ Staff (job_level_id = 3) hanya bisa assign diri sendiri sebagai PIC
    if (Number(employee.job_level_id) === JOB_LEVEL.STAFF) {
      if (picId && Number(picId) !== Number(employee.employee_id)) {
        await conn.rollback();
        return res.status(403).json({ message: "Staff tidak bisa assign PIC ke orang lain" });
      }
      if (!picId) picId = employee.employee_id;
    }

    const [ins] = await conn.query(
      `INSERT INTO tr_pm_task
       (id_monthly, title, \`desc\`, startdate, enddate, owner_employee_id, pic_employee_id, status, priority, evidance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        monthlyId, title.trim(), desc || null,
        startdate || null, enddate || null,
        employee.employee_id, picId,
        status || "assigned", priority || "medium",
        evidance || null,
      ]
    );

    // ✅ Hanya Direktur (1) & Supervisor (2) yang bisa set assignees list
    if (Array.isArray(assignees) && assignees.length) {
      if (!isSupervisorUp(employee)) {
        await conn.rollback();
        return res.status(403).json({ message: "Hanya Supervisor+ yang bisa set assignees" });
      }
      for (const a of assignees) {
        await conn.query(
          `INSERT IGNORE INTO tr_pm_task_assignee (task_id, employee_id, role) VALUES (?, ?, ?)`,
          [ins.insertId, a.employee_id, a.role || "pic"]
        );
      }
    }

    await conn.commit();
    res.status(201).json({ message: "Task created", id: ins.insertId });
  } catch (err) {
    await conn.rollback();
    console.error("createTask error:", err);
    res.status(500).json({ message: err.message });
  } finally {
    conn.release();
  }
}

export async function updateTask(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { taskId } = req.params;
    const employee = await getSessionEmployee(req);

    const [[task]] = await safeQuery(`SELECT * FROM tr_pm_task WHERE id = ? LIMIT 1`, [taskId]);
    if (!task) return res.status(404).json({ message: "Task not found" });

    const isSupUp  = isSupervisorUp(employee);   // Direktur & Supervisor
    const isOwner  = task.owner_employee_id === employee.employee_id;
    const isPic    = task.pic_employee_id   === employee.employee_id;

    if (!isSupUp && !isOwner && !isPic) {
      return res.status(403).json({ message: "Tidak punya akses update task ini" });
    }

    const { title, desc, status, priority, startdate, enddate, evidance, pic_employee_id } = req.body;

    const validStatus = [
      "assigned", "in_progress", "on_hold",
      "submitted_for_review", "revision_required", "approved", "completed",
    ];
    if (status && !validStatus.includes(status)) {
      return res.status(400).json({ message: "Status tidak valid" });
    }

    const fields = [];
    const vals   = [];

    // Staff yang hanya sebagai PIC (bukan owner, bukan Supervisor+)
    // hanya boleh update status & evidance
    if (isPic && !isOwner && !isSupUp) {
      if (status   !== undefined) { fields.push("status = ?");   vals.push(status); }
      if (evidance !== undefined) { fields.push("evidance = ?"); vals.push(evidance || null); }
    } else {
      // Owner atau Supervisor+ bisa update semua
      if (title    !== undefined) { fields.push("title = ?");          vals.push(title?.trim() || task.title); }
      if (desc     !== undefined) { fields.push("`desc` = ?");         vals.push(desc || null); }
      if (status   !== undefined) { fields.push("status = ?");         vals.push(status); }
      if (priority !== undefined) { fields.push("priority = ?");       vals.push(priority); }
      if (startdate!== undefined) { fields.push("startdate = ?");      vals.push(startdate || null); }
      if (enddate  !== undefined) { fields.push("enddate = ?");        vals.push(enddate || null); }
      if (evidance !== undefined) { fields.push("evidance = ?");       vals.push(evidance || null); }
      // Hanya Direktur & Supervisor yang bisa ganti PIC
      if (pic_employee_id !== undefined && isSupUp) {
        fields.push("pic_employee_id = ?");
        vals.push(pic_employee_id || null);
      }
    }

    if (!fields.length) return res.status(400).json({ message: "Tidak ada field yang diupdate" });

    fields.push("updated_at = NOW()");
    vals.push(taskId);

    await safeQuery(`UPDATE tr_pm_task SET ${fields.join(", ")} WHERE id = ?`, vals);

    const [[updated]] = await safeQuery(
      `SELECT t.*, owner.full_name AS owner_name, pic.full_name AS pic_name
       FROM tr_pm_task t
       LEFT JOIN mst_employee owner ON owner.employee_id = t.owner_employee_id AND owner.is_deleted = 0
       LEFT JOIN mst_employee pic   ON pic.employee_id   = t.pic_employee_id   AND pic.is_deleted   = 0
       WHERE t.id = ? LIMIT 1`,
      [taskId]
    );

    const [evidenceFiles] = await safeQuery(
      `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_by, created_at
       FROM tr_pm_task_evidence WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId]
    );

    res.json({ message: "Task updated", task: { ...updated, evidence_files: evidenceFiles } });
  } catch (err) {
    console.error("updateTask error:", err);
    res.status(500).json({ message: err.message });
  }
}

// ─── EVIDENCE ─────────────────────────────────────────────────────────────────
export async function uploadEvidence(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);
    if (!employee) return res.status(403).json({ message: "Employee not found" });

    const { taskId } = req.params;
    const [[task]] = await safeQuery(`SELECT id FROM tr_pm_task WHERE id = ? LIMIT 1`, [taskId]);
    if (!task) return res.status(404).json({ message: "Task not found" });

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: "Tidak ada file yang diupload" });
    }

    const inserted = [];
    for (const file of files) {
      const filePath = `${EVIDENCE_URL_PREFIX}/${file.filename}`;
      const [ins] = await safeQuery(
        `INSERT INTO tr_pm_task_evidence (task_id, file_name, file_path, file_type, file_size, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [taskId, file.originalname, filePath, file.mimetype, file.size, employee.employee_id]
      );
      inserted.push({
        id:          ins.insertId,
        task_id:     Number(taskId),
        file_name:   file.originalname,
        file_path:   filePath,
        file_type:   file.mimetype,
        file_size:   file.size,
        uploaded_by: employee.employee_id,
      });
    }

    res.status(201).json({ message: "Evidence uploaded", data: inserted });
  } catch (err) {
    console.error("uploadEvidence error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function listEvidence(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { taskId } = req.params;
    const [rows] = await safeQuery(
      `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_by, created_at
       FROM tr_pm_task_evidence WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listEvidence error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function deleteEvidence(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);
    const { taskId, evidenceId } = req.params;

    const [[ev]] = await safeQuery(
      `SELECT * FROM tr_pm_task_evidence WHERE id = ? AND task_id = ? LIMIT 1`,
      [evidenceId, taskId]
    );
    if (!ev) return res.status(404).json({ message: "Evidence not found" });

    const [[task]] = await safeQuery(
      `SELECT owner_employee_id FROM tr_pm_task WHERE id = ? LIMIT 1`, [taskId]
    );

    const isSupUp    = isSupervisorUp(employee);
    const isUploader = ev.uploaded_by          === employee.employee_id;
    const isOwner    = task?.owner_employee_id  === employee.employee_id;

    if (!isSupUp && !isUploader && !isOwner) {
      return res.status(403).json({ message: "Tidak punya akses hapus evidence ini" });
    }

    const diskPath = path.join(EVIDENCE_DISK_DIR, path.basename(ev.file_path));
    if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);

    await safeQuery(`DELETE FROM tr_pm_task_evidence WHERE id = ?`, [evidenceId]);
    res.json({ message: "Evidence deleted" });
  } catch (err) {
    console.error("deleteEvidence error:", err);
    res.status(500).json({ message: err.message });
  }
}

// ─── COMMENTS ─────────────────────────────────────────────────────────────────
export async function listTaskComments(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const { taskId } = req.params;
    const [rows] = await safeQuery(
      `SELECT c.id, c.id_task, c.employee_id, c.comment, c.created_at,
              e.full_name AS employee_name, e.email AS employee_email
       FROM tr_pm_task_comment c
       LEFT JOIN mst_employee e ON e.employee_id = c.employee_id AND e.is_deleted = 0
       WHERE c.id_task = ?
       ORDER BY c.created_at ASC`,
      [taskId]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listTaskComments error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function addTaskComment(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const employee = await getSessionEmployee(req);
    if (!employee) return res.status(403).json({ message: "Employee not found" });

    const { taskId } = req.params;
    const { comment } = req.body;
    if (!comment?.trim()) return res.status(400).json({ message: "Comment tidak boleh kosong" });

    const [[task]] = await safeQuery(`SELECT id FROM tr_pm_task WHERE id = ? LIMIT 1`, [taskId]);
    if (!task) return res.status(404).json({ message: "Task not found" });

    const [ins] = await safeQuery(
      `INSERT INTO tr_pm_task_comment (id_task, employee_id, comment) VALUES (?, ?, ?)`,
      [taskId, employee.employee_id, comment.trim()]
    );

    const [[newComment]] = await safeQuery(
      `SELECT c.id, c.id_task, c.employee_id, c.comment, c.created_at,
              e.full_name AS employee_name, e.email AS employee_email
       FROM tr_pm_task_comment c
       LEFT JOIN mst_employee e ON e.employee_id = c.employee_id AND e.is_deleted = 0
       WHERE c.id = ? LIMIT 1`,
      [ins.insertId]
    );

    res.status(201).json({ message: "Comment added", data: newComment });
  } catch (err) {
    console.error("addTaskComment error:", err);
    res.status(500).json({ message: err.message });
  }
}

export async function listEmployees(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const [rows] = await safeQuery(
      `SELECT employee_id, full_name, email, job_level_id
       FROM mst_employee
       WHERE is_deleted = 0
         AND job_level_id != ?
       ORDER BY full_name ASC`,
      [JOB_LEVEL.DIREKTUR]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error("listEmployees error:", err);
    res.status(500).json({ message: err.message });
  }
}