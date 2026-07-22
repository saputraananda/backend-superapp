// controllers/ProjectManagement/projectManagementController.js
import db from "../../db/pool.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.employeeId) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

async function getSessionEmployee(req) {
  const empId = req.session?.employeeId;
  if (!empId) return null;
  const [rows] = await db.query(
    `SELECT e.*, jl.job_level_id
     FROM mst_employee e
     LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
     WHERE e.employee_id = ?`,
    [empId]
  );
  return rows[0] || null;
}

// ─── WORKSPACE (tr_projectmanagement) ────────────────────────────────────────

/**
 * GET /api/pm2/workspaces
 * List semua workspace milik company user
 */
export async function listWorkspaces(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await db.query(
      `SELECT
         p.id,
         p.title,
         p.\`desc\`,
         p.creator_id,
         p.company_id,
         p.employee_ids,
         p.position_ids,
         p.created_at,
         p.updated_at,
         e.full_name AS creator_name,
         (SELECT GROUP_CONCAT(company_name SEPARATOR ', ') FROM mst_company WHERE FIND_IN_SET(company_id, p.company_id) > 0) AS company_name,
         (SELECT COUNT(*) FROM tr_projectmanagement_detail d WHERE d.id_project = p.id AND d.is_deleted = 0) AS sub_count
       FROM tr_projectmanagement p
       LEFT JOIN mst_employee e ON e.employee_id = p.creator_id
       WHERE p.is_deleted = 0
         AND (
           p.creator_id = ?
           OR (
             (p.company_id IS NULL OR p.company_id = '') AND
             (p.employee_ids IS NULL OR p.employee_ids = '') AND
             (p.position_ids IS NULL OR p.position_ids = '')
           )
           OR (p.company_id IS NOT NULL AND p.company_id <> '' AND FIND_IN_SET(?, p.company_id) > 0)
           OR (p.employee_ids IS NOT NULL AND p.employee_ids <> '' AND FIND_IN_SET(?, p.employee_ids) > 0)
           OR (p.position_ids IS NOT NULL AND p.position_ids <> '' AND FIND_IN_SET(?, p.position_ids) > 0)
         )
       ORDER BY p.created_at DESC`,
      [emp.employee_id, emp.company_id, emp.employee_id, emp.position_id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/workspaces
 * Buat workspace baru
 */
export async function createWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { title, desc, company_ids, employee_ids, position_ids } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Nama workspace wajib diisi" });

    let companyIdStr = null;
    if (Array.isArray(company_ids) && company_ids.length > 0) {
      companyIdStr = company_ids.map(Number).join(",");
    }

    let employeeIdStr = null;
    if (Array.isArray(employee_ids) && employee_ids.length > 0) {
      const uniqueEmployeeIds = Array.from(new Set([emp.employee_id, ...employee_ids.map(Number)]));
      employeeIdStr = uniqueEmployeeIds.join(",");
    }

    let positionIdStr = null;
    if (Array.isArray(position_ids) && position_ids.length > 0) {
      positionIdStr = position_ids.map(Number).join(",");
    }

    const [result] = await db.query(
      `INSERT INTO tr_projectmanagement (title, \`desc\`, creator_id, company_id, employee_ids, position_ids)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [title.trim(), desc?.trim() || null, emp.employee_id, companyIdStr, employeeIdStr, positionIdStr]
    );

    res.status(201).json({ message: "Workspace berhasil dibuat", id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * PUT /api/pm2/workspaces/:id
 * Edit workspace
 */
export async function updateWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { title, desc, company_ids, employee_ids, position_ids } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Nama workspace wajib diisi" });

    const [rows] = await db.query(
      `SELECT * FROM tr_projectmanagement WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Workspace tidak ditemukan" });

    let companyIdStr = null;
    if (Array.isArray(company_ids) && company_ids.length > 0) {
      companyIdStr = company_ids.map(Number).join(",");
    }

    let employeeIdStr = null;
    if (Array.isArray(employee_ids) && employee_ids.length > 0) {
      const creatorId = rows[0].creator_id;
      const uniqueEmployeeIds = Array.from(new Set([creatorId, emp.employee_id, ...employee_ids.map(Number)]));
      employeeIdStr = uniqueEmployeeIds.join(",");
    }

    let positionIdStr = null;
    if (Array.isArray(position_ids) && position_ids.length > 0) {
      positionIdStr = position_ids.map(Number).join(",");
    }

    await db.query(
      `UPDATE tr_projectmanagement SET title = ?, \`desc\` = ?, company_id = ?, employee_ids = ?, position_ids = ? WHERE id = ?`,
      [title.trim(), desc?.trim() || null, companyIdStr, employeeIdStr, positionIdStr, id]
    );

    res.json({ message: "Workspace berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * DELETE /api/pm2/workspaces/:id
 * Soft delete workspace
 */
export async function deleteWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT * FROM tr_projectmanagement WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Workspace tidak ditemukan" });

    const ws = rows[0];
    if (ws.creator_id !== emp.employee_id && emp.job_level_id > 2) {
      return res.status(403).json({ message: "Tidak punya izin menghapus workspace ini" });
    }

    await db.query(`UPDATE tr_projectmanagement SET is_deleted = 1 WHERE id = ?`, [id]);
    res.json({ message: "Workspace berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ─── SUB-WORKSPACE (tr_projectmanagement_detail) ─────────────────────────────

/**
 * GET /api/pm2/workspaces/:id/sub
 * List sub-workspace dari sebuah workspace
 */
export async function listSubWorkspaces(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT
         d.id,
         d.id_project,
         d.department_id,
         d.title,
         d.\`desc\`,
         d.creator_id,
         d.created_at,
         d.updated_at,
         e.full_name AS creator_name,
         dep.department_name,
         (SELECT COUNT(*) FROM tr_projectmanagement_task t WHERE t.id_pm_detail = d.id AND t.is_deleted = 0) AS task_count,
         (SELECT COUNT(*) FROM tr_projectmanagement_task t WHERE t.id_pm_detail = d.id AND t.is_deleted = 0 AND t.status = 'Completed') AS completed_count
       FROM tr_projectmanagement_detail d
       LEFT JOIN mst_employee e ON e.employee_id = d.creator_id
       LEFT JOIN mst_department dep ON dep.department_id = d.department_id
       WHERE d.id_project = ? AND d.is_deleted = 0
       ORDER BY d.created_at ASC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/workspaces/:id/sub
 * Buat sub-workspace baru
 */
export async function createSubWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { title, desc, department_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Nama sub-workspace wajib diisi" });

    // Cek workspace exists
    const [wsRows] = await db.query(
      `SELECT id FROM tr_projectmanagement WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!wsRows.length) return res.status(404).json({ message: "Workspace tidak ditemukan" });

    const [result] = await db.query(
      `INSERT INTO tr_projectmanagement_detail (id_project, department_id, title, \`desc\`, creator_id)
       VALUES (?, ?, ?, ?, ?)`,
      [id, department_id || null, title.trim(), desc?.trim() || null, emp.employee_id]
    );

    res.status(201).json({ message: "Sub-workspace berhasil dibuat", id: result.insertId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * PUT /api/pm2/sub-workspaces/:id
 * Edit sub-workspace
 */
export async function updateSubWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { title, desc, department_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Nama sub-workspace wajib diisi" });

    const [rows] = await db.query(
      `SELECT * FROM tr_projectmanagement_detail WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Sub-workspace tidak ditemukan" });

    const sub = rows[0];
    if (sub.creator_id !== emp.employee_id && emp.job_level_id > 2) {
      return res.status(403).json({ message: "Tidak punya izin mengedit sub-workspace ini" });
    }

    await db.query(
      `UPDATE tr_projectmanagement_detail SET title = ?, \`desc\` = ?, department_id = ? WHERE id = ?`,
      [title.trim(), desc?.trim() || null, department_id || null, id]
    );

    res.json({ message: "Sub-workspace berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * DELETE /api/pm2/sub-workspaces/:id
 * Soft delete sub-workspace
 */
export async function deleteSubWorkspace(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT * FROM tr_projectmanagement_detail WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "Sub-workspace tidak ditemukan" });

    const sub = rows[0];
    if (sub.creator_id !== emp.employee_id && emp.job_level_id > 2) {
      return res.status(403).json({ message: "Tidak punya izin menghapus sub-workspace ini" });
    }

    await db.query(
      `UPDATE tr_projectmanagement_detail SET is_deleted = 1 WHERE id = ?`,
      [id]
    );
    res.json({ message: "Sub-workspace berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ─── TASKS (tr_projectmanagement_task) ───────────────────────────────────────

/**
 * GET /api/pm2/sub-workspaces/:id/tasks
 * List tasks dari sebuah sub-workspace
 */
export async function listTasks(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT
         t.id,
         t.id_pm_detail,
         t.title,
         t.\`desc\`,
         t.startdate,
         t.enddate,
         t.status,
         t.priority,
         t.evidance,
         t.evidance_path,
         t.link,
         t.owner_employee_id,
         t.pic_employee_id,
         t.position_id,
         t.created_at,
         t.updated_at,
         eo.full_name AS owner_name,
         ep.full_name AS pic_name,
         mp.position_name
       FROM tr_projectmanagement_task t
       LEFT JOIN mst_employee eo ON eo.employee_id = t.owner_employee_id
       LEFT JOIN mst_employee ep ON ep.employee_id = t.pic_employee_id
       LEFT JOIN mst_position mp ON mp.position_id = t.position_id
       WHERE t.id_pm_detail = ? AND t.is_deleted = 0
       ORDER BY t.created_at DESC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/workspaces/:id/tasks
 * List semua task dari seluruh sub-workspace di workspace tersebut
 */
export async function listWorkspaceTasks(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT
         t.id,
         t.id_pm_detail,
         t.title,
         t.\`desc\`,
         t.startdate,
         t.enddate,
         t.status,
         t.priority,
         t.evidance,
         t.evidance_path,
         t.link,
         t.owner_employee_id,
         t.pic_employee_id,
         t.position_id,
         t.created_at,
         t.updated_at,
         eo.full_name AS owner_name,
         ep.full_name AS pic_name,
         mp.position_name,
         d.title AS sub_workspace_title
       FROM tr_projectmanagement_task t
       LEFT JOIN tr_projectmanagement_detail d ON d.id = t.id_pm_detail AND d.is_deleted = 0
       LEFT JOIN mst_employee eo ON eo.employee_id = t.owner_employee_id
       LEFT JOIN mst_employee ep ON ep.employee_id = t.pic_employee_id
       LEFT JOIN mst_position mp ON mp.position_id = t.position_id
       WHERE t.id_pm = ? AND t.is_deleted = 0
       ORDER BY t.created_at DESC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/sub-workspaces/:id/tasks
 * Buat task baru + assignees (co-pic, reviewer)
 */
export async function createTask(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const {
      title, desc, startdate, enddate,
      pic_employee_id, priority, link, link_title,
      co_pics, reviewers, position_id, id_pm_detail
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ message: "Judul task wajib diisi" });
    if (!pic_employee_id) return res.status(400).json({ message: "PIC wajib dipilih" });

    let final_id_pm = null;
    let final_id_pm_detail = null;

    if (req.originalUrl.includes("/sub-workspaces/")) {
      final_id_pm_detail = id;
      const [subRows] = await db.query(
        `SELECT id_project FROM tr_projectmanagement_detail WHERE id = ? AND is_deleted = 0`,
        [id]
      );
      if (!subRows.length) return res.status(404).json({ message: "Sub-workspace tidak ditemukan" });
      final_id_pm = subRows[0].id_project;
    } else {
      final_id_pm = id;
      if (id_pm_detail) {
        final_id_pm_detail = id_pm_detail;
      }
    }

    // Insert task — link_title disimpan di kolom evidance
    const [result] = await db.query(
      `INSERT INTO tr_projectmanagement_task
         (id_pm, id_pm_detail, title, \`desc\`, startdate, enddate, owner_employee_id, pic_employee_id, position_id, priority, link, evidance, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'To Do')`,
      [
        final_id_pm,
        final_id_pm_detail || null,
        title.trim(),
        desc?.trim() || null,
        startdate || null,
        enddate || null,
        emp.employee_id,
        pic_employee_id,
        position_id || null,
        priority || "medium",
        link?.trim() || null,
        link_title?.trim() || null,
      ]
    );

    const taskId = result.insertId;

    // Assignee: PIC
    await db.query(
      `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES (?, ?, 'pic')`,
      [taskId, pic_employee_id]
    );

    // Assignees: co-pic
    const coPicsArr = Array.isArray(co_pics) ? co_pics : (co_pics ? [co_pics] : []);
    if (coPicsArr.length > 0) {
      const coValues = coPicsArr.map(eId => [taskId, eId, 'co-pic']);
      await db.query(
        `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES ?`,
        [coValues]
      );
    }

    // Assignees: reviewer
    const reviewersArr = Array.isArray(reviewers) ? reviewers : (reviewers ? [reviewers] : []);
    if (reviewersArr.length > 0) {
      const rvValues = reviewersArr.map(eId => [taskId, eId, 'reviewer']);
      await db.query(
        `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES ?`,
        [rvValues]
      );
    }

    res.status(201).json({ message: "Task berhasil dibuat", id: taskId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * PUT /api/pm2/tasks/:id/status
 * Update status task
 */
export async function updateTaskStatus(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ["To Do", "In Progress", "Review", "Completed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Status tidak valid" });
    }

    await db.query(
      `UPDATE tr_projectmanagement_task SET status = ? WHERE id = ? AND is_deleted = 0`,
      [status, id]
    );

    res.json({ message: "Status task berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * PUT /api/pm2/tasks/:id
 * Update task lengkap beserta assignees
 */
export async function updateTask(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const {
      title, desc, startdate, enddate,
      pic_employee_id, priority, link, link_title, status,
      co_pics, reviewers, position_id, id_pm_detail
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ message: "Judul task wajib diisi" });

    const [taskRows] = await db.query(
      `SELECT owner_employee_id FROM tr_projectmanagement_task WHERE id = ? AND is_deleted = 0`,
      [id]
    );
    if (!taskRows.length) return res.status(404).json({ message: "Task tidak ditemukan" });

    await db.query(
      `UPDATE tr_projectmanagement_task
       SET title = ?, \`desc\` = ?, startdate = ?, enddate = ?,
           pic_employee_id = ?, position_id = ?, priority = ?, link = ?, evidance = ?, status = ?,
           id_pm_detail = ?
       WHERE id = ?`,
      [
        title.trim(),
        desc?.trim() || null,
        startdate || null,
        enddate || null,
        pic_employee_id || null,
        position_id || null,
        priority || "medium",
        link?.trim() || null,
        link_title?.trim() || null,
        status || "To Do",
        id_pm_detail || null,
        id
      ]
    );

    // Sync PIC
    await db.query(
      `DELETE FROM tr_projectmanagement_task_assignee WHERE id_pm_task = ? AND role = 'pic'`,
      [id]
    );
    if (pic_employee_id) {
      await db.query(
        `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES (?, ?, 'pic')`,
        [id, pic_employee_id]
      );
    }

    // Sync Co-PICs
    await db.query(
      `DELETE FROM tr_projectmanagement_task_assignee WHERE id_pm_task = ? AND role = 'co-pic'`,
      [id]
    );
    const coPicsArr = Array.isArray(co_pics) ? co_pics : (co_pics ? [co_pics] : []);
    if (coPicsArr.length > 0) {
      const coValues = coPicsArr.map(eId => [id, eId, 'co-pic']);
      await db.query(
        `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES ?`,
        [coValues]
      );
    }

    // Sync Reviewers
    await db.query(
      `DELETE FROM tr_projectmanagement_task_assignee WHERE id_pm_task = ? AND role = 'reviewer'`,
      [id]
    );
    const reviewersArr = Array.isArray(reviewers) ? reviewers : (reviewers ? [reviewers] : []);
    if (reviewersArr.length > 0) {
      const rvValues = reviewersArr.map(eId => [id, eId, 'reviewer']);
      await db.query(
        `INSERT IGNORE INTO tr_projectmanagement_task_assignee (id_pm_task, employee_id, role) VALUES ?`,
        [rvValues]
      );
    }

    res.json({ message: "Task berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/tasks/:id
 * Detail task beserta assignees
 */
export async function getTaskDetail(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT
         t.id,
         t.id_pm,
         t.id_pm_detail,
         t.title,
         t.\`desc\`,
         t.startdate,
         t.enddate,
         t.status,
         t.priority,
         t.evidance AS link_title,
         t.evidance_path,
         t.link,
         t.owner_employee_id,
         t.pic_employee_id,
         t.position_id,
         t.created_at,
         eo.full_name AS owner_name,
         ep.full_name AS pic_name,
         mp.position_name
       FROM tr_projectmanagement_task t
       LEFT JOIN mst_employee eo ON eo.employee_id = t.owner_employee_id
       LEFT JOIN mst_employee ep ON ep.employee_id = t.pic_employee_id
       LEFT JOIN mst_position mp ON mp.position_id = t.position_id
       WHERE t.id = ? AND t.is_deleted = 0`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ message: "Task tidak ditemukan" });
    const task = rows[0];

    const [coRows] = await db.query(
      `SELECT a.employee_id, e.full_name
       FROM tr_projectmanagement_task_assignee a
       JOIN mst_employee e ON e.employee_id = a.employee_id
       WHERE a.id_pm_task = ? AND a.role = 'co-pic'`,
      [id]
    );
    task.co_pics = coRows.map(r => String(r.employee_id));

    const [revRows] = await db.query(
      `SELECT a.employee_id, e.full_name
       FROM tr_projectmanagement_task_assignee a
       JOIN mst_employee e ON e.employee_id = a.employee_id
       WHERE a.id_pm_task = ? AND a.role = 'reviewer'`,
      [id]
    );
    task.reviewers = revRows.map(r => String(r.employee_id));

    const [evRows] = await db.query(
      `SELECT id, file_name, file_path, file_type, file_size, created_at
       FROM tr_projectmanagement_task_evidance
       WHERE id_pm_task = ?
       ORDER BY created_at ASC`,
      [id]
    );
    task.evidences = evRows;

    res.json({ data: task });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/tasks/:id/comments
 * List komentar task
 */
export async function listTaskComments(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT c.id, c.comment, c.created_at, e.full_name AS employee_name, e.profile_path, c.employee_id
       FROM tr_projectmanagement_task_comment c
       JOIN mst_employee e ON e.employee_id = c.employee_id
       WHERE c.id_pm_task = ?
       ORDER BY c.created_at ASC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/tasks/:id/comments
 * Tambah komentar task
 */
export async function createTaskComment(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;
    const { comment } = req.body;

    if (!comment?.trim()) {
      return res.status(400).json({ message: "Komentar tidak boleh kosong" });
    }

    await db.query(
      `INSERT INTO tr_projectmanagement_task_comment (id_pm_task, employee_id, comment)
       VALUES (?, ?, ?)`,
      [id, emp.employee_id, comment.trim()]
    );

    res.status(201).json({ message: "Komentar berhasil ditambahkan" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * DELETE /api/pm2/tasks/:id
 * Soft delete task
 */
export async function deleteTask(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    await db.query(
      `UPDATE tr_projectmanagement_task SET is_deleted = 1 WHERE id = ?`,
      [id]
    );
    res.json({ message: "Task berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ─── HELPER: List employees & departments ─────────────────────────────────────

/**
 * GET /api/pm2/employees
 * List karyawan untuk picker
 */
export async function listEmployees(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT e.employee_id AS id, e.full_name, e.email, dep.department_name
       FROM mst_employee e
       LEFT JOIN mst_department dep ON dep.department_id = e.department_id
       WHERE e.is_deleted = 0 AND e.exit_date IS NULL
       ORDER BY e.full_name ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/departments
 * List department untuk picker
 */
export async function listDepartments(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT department_id AS id, department_name
       FROM mst_department
       WHERE is_active = 1
       ORDER BY department_name ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/companies
 * List company untuk picker visibilitas
 */
export async function listCompanies(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [rows] = await db.query(
      `SELECT company_id AS id, company_name
       FROM mst_company
       WHERE is_active = 1
       ORDER BY company_name ASC`
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/me
 * Data user login untuk auto-fill owner
 */
export async function getMe(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });
    res.json({ id: emp.employee_id, full_name: emp.full_name, nik: emp.nik });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/tasks/:id/evidence
 * Upload lampiran untuk task
 */
export async function uploadTaskEvidence(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ message: "File tidak ditemukan" });

    const fileName = req.file.originalname;
    const filePath = `/assets/pm_evidence/${req.file.filename}`;
    const fileType = req.file.mimetype;
    const fileSize = req.file.size;

    await db.query(
      `INSERT INTO tr_projectmanagement_task_evidance (id_pm_task, file_name, file_path, file_type, file_size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, fileName, filePath, fileType, fileSize, emp.employee_id]
    );
    await db.query(
      `UPDATE tr_projectmanagement_task SET evidance_path = ?, evidance = ? WHERE id = ?`,
      [filePath, fileName, id]
    );

    res.status(201).json({ message: "File berhasil diunggah", file_path: filePath, file_name: fileName });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/tasks/:id/evidence
 * List semua evidence file milik task
 */
export async function listTaskEvidences(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT id, file_name, file_path, file_type, file_size, created_at
       FROM tr_projectmanagement_task_evidance
       WHERE id_pm_task = ?
       ORDER BY created_at ASC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * DELETE /api/pm2/tasks/:id/evidence/:evidenceId
 * Hapus satu evidence file milik task
 */
export async function deleteTaskEvidence(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { id, evidenceId } = req.params;

    // Cek evidence ada & milik task ini
    const [rows] = await db.query(
      `SELECT * FROM tr_projectmanagement_task_evidance WHERE id = ? AND id_pm_task = ?`,
      [evidenceId, id]
    );
    if (!rows.length) return res.status(404).json({ message: "Evidence tidak ditemukan" });

    // Hapus record dari DB
    await db.query(
      `DELETE FROM tr_projectmanagement_task_evidance WHERE id = ?`,
      [evidenceId]
    );

    // Cek apakah masih ada evidence lain untuk task ini
    const [remaining] = await db.query(
      `SELECT id, file_name, file_path FROM tr_projectmanagement_task_evidance
       WHERE id_pm_task = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    if (remaining.length > 0) {
      await db.query(
        `UPDATE tr_projectmanagement_task SET evidance_path = ?, evidance = ? WHERE id = ?`,
        [remaining[0].file_path, remaining[0].file_name, id]
      );
    } else {
      await db.query(
        `UPDATE tr_projectmanagement_task SET evidance_path = NULL, evidance = NULL WHERE id = ?`,
        [id]
      );
    }

    res.json({ message: "Evidence berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/tasks/assigned
 * List semua task yang diassign ke user yang sedang login (sebagai pic, co-pic, atau reviewer)
 */
export async function listMyTasks(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await db.query(
      `SELECT DISTINCT
         t.id,
         t.id_pm_detail,
         t.title,
         t.\`desc\`,
         t.startdate,
         t.enddate,
         t.status,
         t.priority,
         t.evidance,
         t.evidance_path,
         t.link,
         t.owner_employee_id,
         t.pic_employee_id,
         t.position_id,
         t.created_at,
         t.updated_at,
         eo.full_name AS owner_name,
         ep.full_name AS pic_name,
         mp.position_name,
         p.title AS project_title,
         d.title AS sub_workspace_title,
         ta.role AS user_role
       FROM tr_projectmanagement_task t
       LEFT JOIN mst_employee eo ON eo.employee_id = t.owner_employee_id
       LEFT JOIN mst_employee ep ON ep.employee_id = t.pic_employee_id
       LEFT JOIN mst_position mp ON mp.position_id = t.position_id
       LEFT JOIN tr_projectmanagement_detail d ON d.id = t.id_pm_detail AND d.is_deleted = 0
       JOIN tr_projectmanagement p ON p.id = t.id_pm
       JOIN tr_projectmanagement_task_assignee ta ON ta.id_pm_task = t.id
       WHERE t.is_deleted = 0
         AND p.is_deleted = 0
         AND ta.employee_id = ?
       ORDER BY t.created_at DESC`,
      [emp.employee_id]
    );

    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}


