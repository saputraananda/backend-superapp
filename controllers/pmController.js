// src/controllers/pmController.js
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import db from "../db/pool.js";
import { sendWaTaskNotif, sendWaSimpleNotif } from "../utils/waNotify.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EVIDENCE_URL_PREFIX = "/assets/evidence";
const EVIDENCE_DISK_DIR = path.join(__dirname, "..", "assets", "evidence");

const JOB_LEVEL = { DIREKTUR: 1, MANAGER: 2, SUPERVISOR: 3, STAFF: 4 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function getSessionEmployee(req) {
  const empId = req.session?.employeeId;
  if (!empId) return null;
  const [rows] = await db.query(
    "SELECT e.*, jl.job_level_id FROM mst_employee e LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id WHERE e.employee_id = ?",
    [empId]
  );
  return rows[0] || null;
}

function requireAuth(req, res) {
  if (!req.session?.employeeId) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

function isDirektur(employee) { return employee?.job_level_id <= JOB_LEVEL.DIREKTUR; }
function isSupervisorUp(employee) { return employee?.job_level_id <= JOB_LEVEL.SUPERVISOR; }
function isStaffUp(employee) { return employee?.job_level_id <= JOB_LEVEL.STAFF; }

function sanitizeDate(val) {
  if (!val) return null;
  const s = String(val).trim();

  // ✅ Sudah format YYYY-MM-DD → simpan langsung sebagai string
  // MySQL DATE column tidak butuh waktu
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // ✅ Ada T → ambil date part saja, JANGAN biarkan MySQL konversi timezone
  if (s.includes("T")) return s.slice(0, 10);

  return null;
}

// ─── PROJECT ──────────────────────────────────────────────────────────────────
export async function listProjects(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    // Ganti query listProjects menjadi:
    const [rows] = await db.query(
      `SELECT p.id, p.title, p.\`desc\`, p.requestor_employee_id,
          p.company_id, p.created_at, p.updated_at,
          e.full_name AS requestor_name,
          c.company_name
   FROM tr_pm_project p
   LEFT JOIN mst_employee e ON p.requestor_employee_id = e.employee_id
   LEFT JOIN mst_company  c ON c.company_id = p.company_id
   WHERE p.is_deleted = 0
   ORDER BY p.created_at DESC`
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function createProject(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  if (!isSupervisorUp(emp)) return res.status(403).json({ message: "Hanya Direktur/Manager/Supervisor yang bisa membuat project" });

  const { title, desc, company_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

  // Fallback: jika tidak dipilih, pakai company si pembuat
  const finalCompanyId = company_id ? Number(company_id) : (emp.company_id || null);

  try {
    const [r] = await db.query(
      "INSERT INTO tr_pm_project (title, `desc`, company_id, requestor_employee_id) VALUES (?, ?, ?, ?)",
      [title.trim(), desc?.trim() || null, finalCompanyId, emp.employee_id]
    );
    res.status(201).json({ id: r.insertId, title, desc, company_id: finalCompanyId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getProjectDetail(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [projRows] = await db.query(
      `SELECT p.id, p.title, p.\`desc\`, p.requestor_employee_id,
          p.company_id, p.created_at, p.updated_at,
          e.full_name AS requestor_name,
          c.company_name
   FROM tr_pm_project p
   LEFT JOIN mst_employee e ON p.requestor_employee_id = e.employee_id
   LEFT JOIN mst_company  c ON c.company_id = p.company_id
   WHERE p.id = ? AND p.is_deleted = 0`,
      [req.params.projectId]
    );
    if (!projRows[0]) return res.status(404).json({ message: "Project tidak ditemukan" });

    const project = {
      id: projRows[0].id,
      title: projRows[0].title,
      desc: projRows[0].desc,
      requestor_employee_id: projRows[0].requestor_employee_id,
      requestor_name: projRows[0].requestor_name,
      company_id: projRows[0].company_id,
      company_name: projRows[0].company_name,
      created_at: projRows[0].created_at,
      updated_at: projRows[0].updated_at,
    };

    // tr_pm_semester: kolom FK = id_project
    const [semRows] = await db.query(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, e.full_name AS requestor_name,
              s.created_at, s.updated_at
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON s.requestor_employee_id = e.employee_id
       WHERE s.id_project = ? AND s.is_deleted = 0
       ORDER BY s.semester ASC, s.created_at DESC`,
      [req.params.projectId]
    );

    res.json({ project, semesters: semRows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function updateProject(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { projectId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_project WHERE id = ? AND is_deleted = 0",
      [projectId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Project tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa edit" });
    }

    const { title, desc, company_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

    await db.query(
      "UPDATE tr_pm_project SET title=?, `desc`=?, company_id=?, updated_at=NOW() WHERE id=?",
      [title.trim(), desc?.trim() || null, company_id || null, projectId]
    );
    res.json({ message: "Project berhasil diupdate" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function deleteProject(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { projectId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_project WHERE id = ? AND is_deleted = 0",
      [projectId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Project tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa hapus" });
    }

    await db.query(
      "UPDATE tr_pm_project SET is_deleted=1, updated_at=NOW() WHERE id=?",
      [projectId]
    );
    res.json({ message: "Project berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── SEMESTER ─────────────────────────────────────────────────────────────────
// tr_pm_semester: FK ke project = id_project
export async function listSemesters(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, e.full_name AS requestor_name,
              s.created_at, s.updated_at
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON s.requestor_employee_id = e.employee_id
       WHERE s.id_project = ? AND s.is_deleted = 0
       ORDER BY s.semester ASC, s.created_at DESC`,
      [req.params.projectId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function createSemester(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  if (!isSupervisorUp(emp)) return res.status(403).json({ message: "Forbidden" });

  const { semester, title, desc } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });
  if (!semester) return res.status(400).json({ message: "Semester wajib dipilih" });

  try {
    // id_project sebagai FK
    const [r] = await db.query(
      "INSERT INTO tr_pm_semester (id_project, semester, title, `desc`, requestor_employee_id) VALUES (?,?,?,?,?)",
      [req.params.projectId, semester, title.trim(), desc?.trim() || null, emp.employee_id]
    );
    res.status(201).json({ id: r.insertId, semester, title });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getSemesterDetail(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT s.id, s.id_project, s.semester, s.title, s.\`desc\`,
              s.requestor_employee_id, e.full_name AS requestor_name,
              s.created_at, s.updated_at
       FROM tr_pm_semester s
       LEFT JOIN mst_employee e ON s.requestor_employee_id = e.employee_id
       WHERE s.id = ? AND s.is_deleted = 0`,
      [req.params.semesterId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Semester tidak ditemukan" });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function updateSemester(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { semesterId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_semester WHERE id = ? AND is_deleted = 0",
      [semesterId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Semester tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa edit" });
    }

    const { semester, title, desc } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

    await db.query(
      "UPDATE tr_pm_semester SET semester=?, title=?, `desc`=?, updated_at=NOW() WHERE id=?",
      [semester, title.trim(), desc?.trim() || null, semesterId]
    );
    res.json({ message: "Semester berhasil diupdate" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function deleteSemester(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { semesterId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_semester WHERE id = ? AND is_deleted = 0",
      [semesterId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Semester tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa hapus" });
    }

    await db.query(
      "UPDATE tr_pm_semester SET is_deleted=1, updated_at=NOW() WHERE id=?",
      [semesterId]
    );
    res.json({ message: "Semester berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── SUB DIVISION (formerly MONTHLY) ──────────────────────────────────────────
// tr_pm_monthly: FK ke semester = id_semester, FK ke project = id_project
// Kolom `month` diganti `department` — sekarang mewakili Sub Division
export async function listMonthlyBySemester(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.id_project, m.id_semester, m.department, m.title, m.\`desc\`,
              m.requestor_employee_id, e.full_name AS requestor_name,
              m.created_at, m.updated_at
       FROM tr_pm_monthly m
       LEFT JOIN mst_employee e ON m.requestor_employee_id = e.employee_id
       WHERE m.id_semester = ? AND m.is_deleted = 0
       ORDER BY m.title ASC, m.created_at DESC`,
      [req.params.semesterId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function createMonthly(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  if (!isSupervisorUp(emp)) return res.status(403).json({ message: "Forbidden" });

  const { department, title, desc } = req.body;
  if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

  try {
    // Ambil id_project dari semester
    const [semRows] = await db.query(
      "SELECT id_project FROM tr_pm_semester WHERE id = ? AND is_deleted = 0",
      [req.params.semesterId]
    );
    if (!semRows[0]) return res.status(404).json({ message: "Semester tidak ditemukan" });

    const [r] = await db.query(
      "INSERT INTO tr_pm_monthly (id_project, id_semester, department, title, `desc`, requestor_employee_id) VALUES (?,?,?,?,?,?)",
      [semRows[0].id_project, req.params.semesterId, department?.trim() || null, title.trim(), desc?.trim() || null, emp.employee_id]
    );
    res.status(201).json({ id: r.insertId, department, title });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getMonthlyDetail(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT m.id, m.id_project, m.id_semester, m.department, m.title, m.\`desc\`,
              m.requestor_employee_id, e.full_name AS requestor_name,
              m.created_at, m.updated_at
       FROM tr_pm_monthly m
       LEFT JOIN mst_employee e ON m.requestor_employee_id = e.employee_id
       WHERE m.id = ? AND m.is_deleted = 0`,
      [req.params.monthlyId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Sub Division tidak ditemukan" });
    res.json({ data: rows[0] });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function updateMonthly(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { monthlyId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_monthly WHERE id = ? AND is_deleted = 0",
      [monthlyId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Monthly tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa edit" });
    }

    const { department, title, desc } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

    await db.query(
      "UPDATE tr_pm_monthly SET department=?, title=?, `desc`=?, updated_at=NOW() WHERE id=?",
      [department?.trim() || null, title.trim(), desc?.trim() || null, monthlyId]
    );
    res.json({ message: "Sub Division berhasil diupdate" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function deleteMonthly(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { monthlyId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_monthly WHERE id = ? AND is_deleted = 0",
      [monthlyId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Monthly tidak ditemukan" });
    if (rows[0].requestor_employee_id !== emp.employee_id && !isDirektur(emp)) {
      return res.status(403).json({ message: "Hanya creator atau Direktur yang bisa hapus" });
    }

    await db.query(
      "UPDATE tr_pm_monthly SET is_deleted=1, updated_at=NOW() WHERE id=?",
      [monthlyId]
    );
    res.json({ message: "Monthly berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── TASKS ────────────────────────────────────────────────────────────────────
// tr_pm_task: FK ke monthly = id_monthly, owner = owner_employee_id,
//             desc = desc, startdate/enddate (bukan start_date/due_date),
//             tidak ada requestor_employee_id → pakai owner_employee_id
export async function createTask(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { monthlyId } = req.params;
  const { title, desc, startdate, enddate, priority, status, assignee_ids } = req.body;

  if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

  try {
    const [monthRows] = await db.query(
      "SELECT * FROM tr_pm_monthly WHERE id = ? AND is_deleted = 0",
      [monthlyId]
    );
    if (!monthRows[0]) return res.status(404).json({ message: "Monthly tidak ditemukan" });
    const monthly = monthRows[0];

    let finalAssignees = [];
    if (!isSupervisorUp(emp)) {
      const extra = Array.isArray(assignee_ids)
        ? assignee_ids.map(Number).filter((id) => id !== emp.employee_id)
        : [];
      finalAssignees = [emp.employee_id, ...extra];
    } else {
      finalAssignees = Array.isArray(assignee_ids)
        ? assignee_ids.map(Number)
        : assignee_ids ? [Number(assignee_ids)] : [];
    }

    // PIC = assignee pertama, atau emp sendiri
    const picId = finalAssignees[0] ?? emp.employee_id;

    const [r] = await db.query(
      `INSERT INTO tr_pm_task
       (id_monthly, title, \`desc\`, startdate, enddate, priority, status,
        owner_employee_id, pic_employee_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        monthlyId, title.trim(), desc?.trim() || null,
        sanitizeDate(startdate), sanitizeDate(enddate),
        priority || "medium", status || "assigned",
        emp.employee_id, picId,
      ]
    );
    const taskId = r.insertId;

    // Insert assignees dengan role
    if (finalAssignees.length > 0) {
      const vals = finalAssignees.map((eid, idx) => [taskId, eid, idx === 0 ? "pic" : "co_pic"]);
      await db.query(
        "INSERT IGNORE INTO tr_pm_task_assignee (task_id, employee_id, role) VALUES ?",
        [vals]
      );
    }

    // Notif ke supervisor (owner monthly) jika yang create adalah staff
    if (!isSupervisorUp(emp) && monthly.requestor_employee_id && monthly.requestor_employee_id !== emp.employee_id) {
      await db.query(
        `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message)
         VALUES (?, ?, ?, ?)`,
        [taskId, monthly.requestor_employee_id, emp.employee_id,
          `${emp.full_name} menambahkan task baru: "${title.trim()}"`]
      );
    }

    // Notif ke assignee yang bukan creator
    for (const eid of finalAssignees) {
      if (eid !== emp.employee_id) {
        await db.query(
          `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message)
           VALUES (?, ?, ?, ?)`,
          [taskId, eid, emp.employee_id,
            `${emp.full_name} menugaskan task "${title.trim()}" kepada Anda`]
        );
      }
    }

    await sendWaTaskNotif({
      assigneeIds: finalAssignees.filter(eid => eid !== emp.employee_id),
      taskTitle: title.trim(),
      monthlyTitle: monthly.title,
      creatorName: emp.full_name,
      startdate: sanitizeDate(startdate),
      enddate: sanitizeDate(enddate),
      monthlyId: monthlyId,
    });

    res.status(201).json({ id: taskId, title });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function updateTask(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { taskId } = req.params;
  const { title, desc, startdate, enddate, priority, status, assignee_ids } = req.body;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_task WHERE id = ? AND is_deleted = 0",
      [taskId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Task tidak ditemukan" });
    const oldTask = rows[0];
    const oldStatus = oldTask.status;

    // ✅ Merge dengan data lama — jika field tidak dikirim, pakai nilai lama
    const finalTitle = title !== undefined ? title?.trim() : oldTask.title;
    const finalDesc = desc !== undefined ? desc?.trim() || null : oldTask.desc;
    const finalStart = startdate !== undefined ? sanitizeDate(startdate) : oldTask.startdate;
    const finalEnd = enddate !== undefined ? sanitizeDate(enddate) : oldTask.enddate;
    const finalStatus = status !== undefined ? status : oldTask.status;
    const finalPriority = priority !== undefined ? priority : oldTask.priority;

    // Validasi title tidak boleh null/kosong
    if (!finalTitle) return res.status(400).json({ message: "Title wajib diisi" });

    await db.query(
      `UPDATE tr_pm_task
       SET title=?, \`desc\`=?, startdate=?, enddate=?, priority=?, status=?, updated_at=NOW()
       WHERE id=?`,
      [finalTitle, finalDesc, finalStart, finalEnd, finalPriority, finalStatus, taskId]
    );

    // ✅ Update assignees HANYA jika assignee_ids dikirim (tidak undefined)
    if (assignee_ids !== undefined) {
      const [oldAssigneeRows] = await db.query(
        "SELECT employee_id FROM tr_pm_task_assignee WHERE task_id = ?", [taskId]
      );
      const oldAssigneeSet = new Set(oldAssigneeRows.map((a) => a.employee_id));

      await db.query("DELETE FROM tr_pm_task_assignee WHERE task_id = ?", [taskId]);

      let finalAssignees = [];
      if (!isSupervisorUp(emp)) {
        const extra = Array.isArray(assignee_ids)
          ? assignee_ids.map(Number).filter((id) => id !== emp.employee_id)
          : [];
        finalAssignees = [emp.employee_id, ...extra];
      } else {
        finalAssignees = Array.isArray(assignee_ids)
          ? assignee_ids.map(Number)
          : assignee_ids ? [Number(assignee_ids)] : [];
      }

      if (finalAssignees.length > 0) {
        const vals = finalAssignees.map((eid, idx) => [taskId, eid, idx === 0 ? "pic" : "co_pic"]);
        await db.query(
          "INSERT IGNORE INTO tr_pm_task_assignee (task_id, employee_id, role) VALUES ?",
          [vals]
        );
        await db.query(
          "UPDATE tr_pm_task SET pic_employee_id=? WHERE id=?",
          [finalAssignees[0], taskId]
        );
      }

      // Notif ke assignee baru
      for (const eid of finalAssignees) {
        if (eid !== emp.employee_id && !oldAssigneeSet.has(eid)) {
          await db.query(
            `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message)
             VALUES (?, ?, ?, ?)`,
            [taskId, eid, emp.employee_id,
              `${emp.full_name} menugaskan task "${finalTitle}" kepada Anda`]
          );
        }
      }
    }

    // ✅ Notif status change — hanya jika status benar-benar berubah
    if (finalStatus !== oldStatus) {
      const [monthRows] = await db.query(
        "SELECT requestor_employee_id FROM tr_pm_monthly WHERE id = ? AND is_deleted = 0",
        [oldTask.id_monthly]
      );
      if (monthRows[0] && monthRows[0].requestor_employee_id !== emp.employee_id) {
        await db.query(
          `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message)
           VALUES (?, ?, ?, ?)`,
          [taskId, monthRows[0].requestor_employee_id, emp.employee_id,
            `${emp.full_name} mengubah status task "${finalTitle}" menjadi "${finalStatus}"`]
        );
      }
    }

    // WA Notif singkat ke assignee
    try {
      const [aRows] = await db.query(
        "SELECT employee_id FROM tr_pm_task_assignee WHERE task_id = ?", [taskId]
      );
      const notifIds = aRows.map(a => a.employee_id).filter(eid => eid !== emp.employee_id);
      if (notifIds.length > 0) {
        const changes = [];
        if (title !== undefined && finalTitle !== oldTask.title)
          changes.push(`• Judul: _"${oldTask.title}"_ → _"${finalTitle}"_`);
        if (status !== undefined && finalStatus !== oldStatus)
          changes.push(`• Status: ${oldStatus} → *${finalStatus}*`);
        if (priority !== undefined && finalPriority !== oldTask.priority)
          changes.push(`• Prioritas: ${oldTask.priority} → *${finalPriority}*`);
        if (startdate !== undefined && String(finalStart) !== String(oldTask.startdate))
          changes.push(`• Tanggal Mulai: *${finalStart || "-"}*`);
        if (enddate !== undefined && String(finalEnd) !== String(oldTask.enddate))
          changes.push(`• Due Date: *${finalEnd || "-"}*`);

        const changeInfo = changes.length > 0 ? changes.join("\n") : "• Detail task diperbarui";

        await sendWaSimpleNotif({
          recipientIds: notifIds,
          message: [
            `✏️ *Task Kamu Diperbarui!*`,
            `━━━━━━━━━━━━━━━`,
            ``,
            `📌 *${finalTitle}*`,
            ``,
            `📝 *Perubahan:*`,
            changeInfo,
            ``,
            `👤 Oleh: ${emp.full_name || "Supervisor"}`,
            ``,
            `Mohon dicek yaa perubahannya 🙏`,
            ``,
            `Salam,`,
            `_minbot Alora_ 🤖`,
          ].join("\n"),
        });
      }
    } catch { /* tetap lanjut */ }

    res.json({ message: "Task berhasil diupdate" });
  } catch (e) {
    console.error("[updateTask]", e);
    res.status(500).json({ message: e.message });
  }
}

export async function deleteTask(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { taskId } = req.params;

  try {
    const [rows] = await db.query(
      "SELECT * FROM tr_pm_task WHERE id = ? AND is_deleted = 0",
      [taskId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Task tidak ditemukan" });

    // owner_employee_id sebagai pemilik task
    if (rows[0].owner_employee_id !== emp.employee_id && !isSupervisorUp(emp)) {
      return res.status(403).json({ message: "Kamu tidak punya akses hapus task ini, hubungi owner" });
    }

    // WA Notif singkat ke assignee
    try {
      const [aRows] = await db.query(
        "SELECT employee_id FROM tr_pm_task_assignee WHERE task_id = ?", [taskId]
      );
      const notifIds = aRows.map(a => a.employee_id).filter(eid => eid !== emp.employee_id);
      if (notifIds.length > 0) {
        await sendWaSimpleNotif({
          recipientIds: notifIds,
          message: [
            `🗑️ *Task Kamu Dihapus*`,
            `━━━━━━━━━━━━━━━`,
            ``,
            `📌 *${rows[0].title}*`,
            ``,
            `👤 Dihapus oleh: ${emp.full_name || "Supervisor"}`,
            ``,
            `Anda tidak perlu mengerjakannya yaa 😊`,
            ``,
            `Salam,`,
            `_minbot Alora_ 🤖`,
          ].join("\n"),
        });
      }
    } catch { /* tetap lanjut */ }

    await db.query(
      "UPDATE tr_pm_task SET is_deleted=1, updated_at=NOW() WHERE id=?",
      [taskId]
    );
    res.json({ message: "Task berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function getMonthlyTasksWithAssignees(req, res) {
  if (!requireAuth(req, res)) return;
  const { monthlyId } = req.params;

  try {
    const [rawTasks] = await db.query(
      `SELECT t.id, t.id_monthly, t.title, t.\`desc\`,
              t.startdate, t.enddate, t.priority, t.status,
              t.evidance, t.evidance_path,
              t.owner_employee_id, t.pic_employee_id,
              eo.full_name AS owner_name, eo.email AS owner_email,
              ep.full_name AS pic_name, ep.email AS pic_email,
              t.created_at, t.updated_at
       FROM tr_pm_task t
       LEFT JOIN mst_employee eo ON t.owner_employee_id = eo.employee_id
       LEFT JOIN mst_employee ep ON t.pic_employee_id = ep.employee_id
       WHERE t.id_monthly = ? AND t.is_deleted = 0
       ORDER BY t.created_at DESC`,
      [monthlyId]
    );

    const tasks = rawTasks.map(t => ({ ...t, assignees: [], evidence_files: [] }));

    if (tasks.length > 0) {
      const taskIds = tasks.map((t) => t.id);

      // tr_pm_task_assignee: kolom role ada
      const [assignees] = await db.query(
        `SELECT ta.task_id, ta.role, e.employee_id, e.full_name, e.email
         FROM tr_pm_task_assignee ta
         JOIN mst_employee e ON ta.employee_id = e.employee_id
         WHERE ta.task_id IN (?)`,
        [taskIds]
      );

      // tr_pm_task_evidence: tidak ada is_deleted di schema
      let evidences = [];
      try {
        const [evRows] = await db.query(
          `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_by, created_at
           FROM tr_pm_task_evidence
           WHERE task_id IN (?)
           ORDER BY created_at DESC`,
          [taskIds]
        );
        evidences = evRows;
      } catch (_) {
        // tabel evidence mungkin belum ada
      }

      const assigneeMap = {};
      assignees.forEach((a) => {
        if (!assigneeMap[a.task_id]) assigneeMap[a.task_id] = [];
        assigneeMap[a.task_id].push({
          employee_id: a.employee_id,
          full_name: a.full_name,
          email: a.email,
          role: a.role,
        });
      });

      const evidenceMap = {};
      evidences.forEach((ev) => {
        if (!evidenceMap[ev.task_id]) evidenceMap[ev.task_id] = [];
        evidenceMap[ev.task_id].push(ev);
      });

      tasks.forEach((t) => {
        t.assignees = assigneeMap[t.id] || [];
        t.evidence_files = evidenceMap[t.id] || [];
      });
    }

    res.json({ data: tasks });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── COMMENTS ─────────────────────────────────────────────────────────────────
// tr_pm_task_comment: kolom FK = id_task, kolom isi = comment (bukan content)
export async function listComments(req, res) {
  if (!requireAuth(req, res)) return;
  const { taskId } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT c.id, c.id_task, c.comment, c.created_at,
              e.employee_id, e.full_name, e.email
       FROM tr_pm_task_comment c
       LEFT JOIN mst_employee e ON c.employee_id = e.employee_id
       WHERE c.id_task = ?
       ORDER BY c.created_at ASC`,
      [taskId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function addComment(req, res) {
  if (!requireAuth(req, res)) return;
  const emp = await getSessionEmployee(req);
  const { taskId } = req.params;
  const { comment, mentioned_ids } = req.body;  // ← tambah mentioned_ids
  if (!comment?.trim()) return res.status(400).json({ message: "Comment kosong" });

  try {
    const [taskRows] = await db.query(
      `SELECT t.*, m.requestor_employee_id AS monthly_owner
       FROM tr_pm_task t
       LEFT JOIN tr_pm_monthly m ON t.id_monthly = m.id
       WHERE t.id = ?`,
      [taskId]
    );
    const task = taskRows[0];

    const [r] = await db.query(
      "INSERT INTO tr_pm_task_comment (id_task, employee_id, comment) VALUES (?,?,?)",
      [taskId, emp.employee_id, comment.trim()]
    );

    if (task) {
      const notifRecipients = new Set();
      if (task.monthly_owner && task.monthly_owner !== emp.employee_id)
        notifRecipients.add(task.monthly_owner);
      if (task.owner_employee_id && task.owner_employee_id !== emp.employee_id)
        notifRecipients.add(task.owner_employee_id);

      const [assigneeRows] = await db.query(
        "SELECT employee_id FROM tr_pm_task_assignee WHERE task_id = ?", [taskId]
      );
      assigneeRows.forEach((a) => {
        if (a.employee_id !== emp.employee_id) notifRecipients.add(a.employee_id);
      });

      // Notif comment_added ke recipients biasa
      for (const recipientId of notifRecipients) {
        await db.query(
          `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message, type)
           VALUES (?, ?, ?, ?, ?)`,
          [taskId, recipientId, emp.employee_id,
            `${emp.full_name} mengomentari task "${task.title}": "${comment.trim().substring(0, 80)}${comment.trim().length > 80 ? "..." : ""}"`,
            'comment_added']  // ← tambah type
        );
      }

      // ─── Notif @mention ───────────────────────────────────────
      if (Array.isArray(mentioned_ids) && mentioned_ids.length > 0) {
        const validIds = mentioned_ids
          .map(Number)
          .filter((id) => !isNaN(id) && id !== emp.employee_id);

        for (const mentionedId of validIds) {
          // Jika belum dapat notif comment_added, kirim notif mention
          if (!notifRecipients.has(mentionedId)) {
            await db.query(
              `INSERT INTO tr_pm_task_notif (task_id, recipient_employee_id, sender_employee_id, message, type)
               VALUES (?, ?, ?, ?, ?)`,
              [taskId, mentionedId, emp.employee_id,
                `${emp.full_name} menyebut Anda dalam komentar di task "${task.title}": "${comment.trim().substring(0, 60)}${comment.trim().length > 60 ? "..." : ""}"`,
                'mentioned']
            );
          } else {
            // Sudah dapat notif, upgrade jadi mention (opsional: bisa skip)
            // Atau biarkan saja karena sudah dapat notif
          }
        }
      }
    }

    res.status(201).json({ id: r.insertId, comment });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── EVIDENCE ─────────────────────────────────────────────────────────────────
// tr_pm_task_evidence: tidak ada is_deleted di schema
export async function listEvidence(req, res) {
  const employee = await getSessionEmployee(req);
  if (!employee) return res.status(401).json({ message: "Unauthorized" });

  const { taskId } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT e.id, e.task_id, e.file_name, e.file_path,
              e.file_type, e.file_size, e.uploaded_by, e.created_at,
              emp.full_name AS uploader_name
       FROM tr_pm_task_evidence e
       LEFT JOIN mst_employee emp ON e.uploaded_by = emp.employee_id
       WHERE e.task_id = ?
       ORDER BY e.created_at DESC`,
      [taskId]
    );
    res.json({ data: rows });
  } catch (e) {
    console.error("[listEvidence]", e);
    res.status(500).json({ message: e.message });
  }
}

export async function uploadEvidence(req, res) {
  const employee = await getSessionEmployee(req);
  if (!employee) return res.status(401).json({ message: "Unauthorized" });

  const { taskId } = req.params;
  const uploadedFiles = req.files || [];

  if (!uploadedFiles.length)
    return res.status(400).json({ message: "Tidak ada file yang diupload" });

  try {
    const inserted = [];
    for (const file of uploadedFiles) {
      const filePath = `${EVIDENCE_URL_PREFIX}/${file.filename}`;
      const [r] = await db.query(
        `INSERT INTO tr_pm_task_evidence
         (task_id, file_name, file_path, file_type, file_size, uploaded_by)
         VALUES (?,?,?,?,?,?)`,
        [taskId, file.originalname, filePath, file.mimetype, file.size, employee.employee_id]
      );
      inserted.push({
        id: r.insertId,
        task_id: taskId,
        file_name: file.originalname,
        file_path: filePath,
        file_type: file.mimetype,
        file_size: file.size,
      });
    }
    res.status(201).json({ data: inserted });
  } catch (e) {
    console.error("[uploadEvidence]", e);
    res.status(500).json({ message: e.message });
  }
}

export async function deleteEvidence(req, res) {
  const employee = await getSessionEmployee(req);
  if (!employee) return res.status(401).json({ message: "Unauthorized" });

  const { evidenceId } = req.params;
  try {
    const [[row]] = await db.query(
      "SELECT * FROM tr_pm_task_evidence WHERE id = ?", [evidenceId]
    );
    if (!row) return res.status(404).json({ message: "File tidak ditemukan" });

    // Hapus file fisik
    if (row.file_type !== "link") {
      const diskPath = path.join(EVIDENCE_DISK_DIR, path.basename(row.file_path));
      fs.unlink(diskPath, () => { });
    }

    await db.query("DELETE FROM tr_pm_task_evidence WHERE id = ?", [evidenceId]);
    res.json({ message: "File berhasil dihapus" });
  } catch (e) {
    console.error("[deleteEvidence]", e);
    res.status(500).json({ message: e.message });
  }
}

// ─── EMPLOYEES ────────────────────────────────────────────────────────────────
export async function listEmployees(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT e.employee_id, e.full_name, e.email, jl.job_level_name
       FROM mst_employee e
       LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
       WHERE e.is_deleted = 0 and e.exit_date IS NULL
       ORDER BY e.full_name ASC`
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
export async function listNotifications(req, res) {
  if (!requireAuth(req, res)) return;
  const empId = req.session.employeeId;
  try {
    const [rows] = await db.query(
      `SELECT n.id, n.task_id, n.type, n.message, n.is_read, n.created_at,
          t.title AS task_title,
          t.id_monthly AS monthly_id,
          e.full_name AS sender_name
      FROM tr_pm_task_notif n
      LEFT JOIN tr_pm_task t ON n.task_id = t.id
      LEFT JOIN mst_employee e ON n.sender_employee_id = e.employee_id
      WHERE n.recipient_employee_id = ?
      ORDER BY n.created_at DESC
      LIMIT 50`,
      [empId]
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function markNotifRead(req, res) {
  if (!requireAuth(req, res)) return;
  const empId = req.session.employeeId;
  const { notifId } = req.params;
  try {
    await db.query(
      "UPDATE tr_pm_task_notif SET is_read=1 WHERE id=? AND recipient_employee_id=?",
      [notifId, empId]
    );
    res.json({ message: "Notif ditandai sudah dibaca" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function markAllNotifRead(req, res) {
  if (!requireAuth(req, res)) return;
  const empId = req.session.employeeId;
  try {
    await db.query(
      "UPDATE tr_pm_task_notif SET is_read=1 WHERE recipient_employee_id=? AND is_read=0",
      [empId]
    );
    res.json({ message: "Semua notif ditandai sudah dibaca" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function deleteNotif(req, res) {
  if (!requireAuth(req, res)) return;
  const empId = req.session.employeeId;
  const { notifId } = req.params;
  try {
    const [rows] = await db.query(
      "SELECT id FROM tr_pm_task_notif WHERE id = ? AND recipient_employee_id = ?",
      [notifId, empId]
    );
    if (!rows[0]) return res.status(404).json({ message: "Notifikasi tidak ditemukan" });

    await db.query(
      "DELETE FROM tr_pm_task_notif WHERE id = ? AND recipient_employee_id = ?",
      [notifId, empId]
    );
    res.json({ message: "Notifikasi berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function deleteAllNotif(req, res) {
  if (!requireAuth(req, res)) return;
  const empId = req.session.employeeId;
  try {
    await db.query(
      "DELETE FROM tr_pm_task_notif WHERE recipient_employee_id = ?",
      [empId]
    );
    res.json({ message: "Semua notifikasi berhasil dihapus" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ─── GLOBAL TASK SEARCH ───────────────────────────────────────────────────────
export async function searchTasks(req, res) {
  if (!requireAuth(req, res)) return;
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ data: [] });

  const like = `%${q}%`;
  try {
    const [tasks] = await db.query(
      `SELECT
         t.id, t.title, t.status, t.priority, t.startdate, t.enddate,
         t.id_monthly, t.owner_employee_id,
         eo.full_name AS owner_name,
         m.title AS monthly_title, m.department AS monthly_dept,
         s.title AS semester_title,
         p.id AS project_id, p.title AS project_title
       FROM tr_pm_task t
       LEFT JOIN mst_employee eo ON t.owner_employee_id = eo.employee_id
       LEFT JOIN tr_pm_monthly m  ON t.id_monthly  = m.id
       LEFT JOIN tr_pm_semester s ON m.id_semester = s.id
       LEFT JOIN tr_pm_project  p ON s.id_project  = p.id
       WHERE t.is_deleted = 0
         AND (
           t.title LIKE ?
           OR EXISTS (
             SELECT 1 FROM tr_pm_task_assignee ta
             JOIN mst_employee ea ON ta.employee_id = ea.employee_id
             WHERE ta.task_id = t.id AND ea.full_name LIKE ?
           )
         )
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [like, like]
    );

    if (tasks.length === 0) return res.json({ data: [] });

    const taskIds = tasks.map((t) => t.id);
    const [assignees] = await db.query(
      `SELECT ta.task_id, e.employee_id, e.full_name
       FROM tr_pm_task_assignee ta
       JOIN mst_employee e ON ta.employee_id = e.employee_id
       WHERE ta.task_id IN (?)`,
      [taskIds]
    );

    const assigneeMap = {};
    assignees.forEach((a) => {
      if (!assigneeMap[a.task_id]) assigneeMap[a.task_id] = [];
      assigneeMap[a.task_id].push({ employee_id: a.employee_id, full_name: a.full_name });
    });

    const result = tasks.map((t) => ({ ...t, assignees: assigneeMap[t.id] || [] }));
    res.json({ data: result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function listCompanies(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      "SELECT company_id, company_name FROM mst_company WHERE is_active = 1 ORDER BY company_name"
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function listDepartments(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      "SELECT department_id, department_name FROM mst_department WHERE is_active = 1 ORDER BY department_name"
    );
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

export async function addEvidenceLink(req, res) {
  const employee = await getSessionEmployee(req);
  if (!employee) return res.status(401).json({ message: "Unauthorized" });

  const { taskId } = req.params;
  const { url, label } = req.body;

  if (!url?.trim()) return res.status(400).json({ message: "URL wajib diisi" });

  try {
    const displayName = label?.trim() || url.trim();
    const [r] = await db.query(
      `INSERT INTO tr_pm_task_evidence
       (task_id, file_name, file_path, file_type, file_size, uploaded_by)
       VALUES (?,?,?,?,?,?)`,
      [taskId, displayName, url.trim(), "link", 0, employee.employee_id]
    );
    res.status(201).json({
      data: {
        id: r.insertId,
        task_id: taskId,
        file_name: displayName,
        file_path: url.trim(),
        file_type: "link",
        file_size: 0,
      },
    });
  } catch (e) {
    console.error("[addEvidenceLink]", e);
    res.status(500).json({ message: e.message });
  }
}