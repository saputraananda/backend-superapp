import path from "path";
import fs from "fs";
import { safeQuery } from "../db/pool.js";

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(process.cwd(), "assets");

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Safely parse JSON array from DB column → number[]
const parseJsonIds = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(Number);
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch { return []; }
};

// Stringify IDs array for DB (null if empty)
const toJsonIds = (raw) => {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0 ? JSON.stringify(arr.map(Number)) : null;
  } catch { return null; }
};

// Batch-fetch display names for company/dept/employee IDs
async function fetchTargetNames(companyIds, deptIds, empIds) {
  let companyMap = {}, deptMap = {}, empMap = {};

  if (companyIds.length > 0) {
    const ph = companyIds.map(() => "?").join(",");
    const [rows] = await safeQuery(
      `SELECT company_id, company_name FROM mst_company WHERE company_id IN (${ph})`, companyIds
    );
    rows.forEach((r) => { companyMap[r.company_id] = r.company_name; });
  }
  if (deptIds.length > 0) {
    const ph = deptIds.map(() => "?").join(",");
    const [rows] = await safeQuery(
      `SELECT department_id, department_name FROM mst_department WHERE department_id IN (${ph})`, deptIds
    );
    rows.forEach((r) => { deptMap[r.department_id] = r.department_name; });
  }
  if (empIds.length > 0) {
    const ph = empIds.map(() => "?").join(",");
    const [rows] = await safeQuery(
      `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`, empIds
    );
    rows.forEach((r) => { empMap[r.employee_id] = r.full_name; });
  }
  return { companyMap, deptMap, empMap };
}

// Attach enriched target arrays to a task object
function enrichTask(task, companyMap, deptMap, empMap) {
  const cIds = parseJsonIds(task.target_company_ids);
  const dIds = parseJsonIds(task.target_department_ids);
  const eIds = parseJsonIds(task.target_employee_ids);
  return {
    ...task,
    target_company_ids: cIds,
    target_department_ids: dIds,
    target_employee_ids: eIds,
    target_companies:   cIds.map((id) => ({ id, name: companyMap[id] || "" })).filter((c) => c.name),
    target_departments: dIds.map((id) => ({ id, name: deptMap[id]   || "" })).filter((d) => d.name),
    target_employees:   eIds.map((id) => ({ id, name: empMap[id]    || "" })).filter((e) => e.name),
  };
}

// ─── GET ALL TASKS ───────────────────────────────────────────────────────────
export const getTasks = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    // 1. Resolve role
    const [roleRows] = await safeQuery(`SELECT role FROM users WHERE id = ?`, [userId]);
    const role = roleRows[0]?.role || null;
    const isAdmin = ["superadmin", "admin", "bod"].includes(role);

    // 2. Resolve employee info — prefer session.employeeId, fallback to email JOIN
    let empInfo = { employee_id: null, company_id: null, department_id: null };
    const sessionEmployeeId = req.session?.employeeId;
    if (sessionEmployeeId) {
      const [r] = await safeQuery(
        `SELECT employee_id, company_id, department_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1`,
        [sessionEmployeeId]
      );
      if (r[0]) empInfo = r[0];
    } else {
      const [r] = await safeQuery(
        `SELECT e.employee_id, e.company_id, e.department_id
         FROM users u
         JOIN mst_employee e ON e.email = u.email AND e.is_deleted = 0
         WHERE u.id = ?
         ORDER BY e.join_date DESC LIMIT 1`,
        [userId]
      );
      if (r[0]) empInfo = r[0];
    }

    console.log(`[getTasks] userId=${userId} role=${role} isAdmin=${isAdmin} empInfo=`, empInfo);

    // 3. Build visibility WHERE clause in SQL (JSON_CONTAINS — far more reliable than JS filter)

    let visibilitySql;
    const visibilityParams = [];

    if (isAdmin) {
      visibilitySql = "1=1"; // admin sees everything
    } else {
      const orClauses = [
        // creator always sees own
        `t.creator_id = ?`,
        // no targets at all + public
        `(
          (t.target_company_ids    IS NULL OR JSON_LENGTH(t.target_company_ids)    = 0)
          AND (t.target_department_ids IS NULL OR JSON_LENGTH(t.target_department_ids) = 0)
          AND (t.target_employee_ids   IS NULL OR JSON_LENGTH(t.target_employee_ids)   = 0)
          AND t.is_public = 1
        )`,
      ];
      visibilityParams.push(Number(userId));

      if (empInfo.company_id != null) {
        orClauses.push(
          `(JSON_LENGTH(t.target_company_ids) > 0 AND JSON_CONTAINS(t.target_company_ids, ?))`
        );
        visibilityParams.push(String(empInfo.company_id));
      }
      if (empInfo.department_id != null) {
        orClauses.push(
          `(JSON_LENGTH(t.target_department_ids) > 0 AND JSON_CONTAINS(t.target_department_ids, ?))`
        );
        visibilityParams.push(String(empInfo.department_id));
      }
      if (empInfo.employee_id != null) {
        orClauses.push(
          `(JSON_LENGTH(t.target_employee_ids) > 0 AND JSON_CONTAINS(t.target_employee_ids, ?))`
        );
        visibilityParams.push(String(empInfo.employee_id));
      }

      visibilitySql = `(${orClauses.join(" OR ")})`;
    }

    console.log(`[getTasks] visibilitySql=`, visibilitySql);
    console.log(`[getTasks] visibilityParams=`, visibilityParams);

    const [tasks] = await safeQuery(
      `SELECT
        t.id,
        t.title,
        t.description,
        t.department_id,
        d.department_name,
        t.is_public,
        t.creator_id,
        t.target_company_ids,
        t.target_department_ids,
        t.target_employee_ids,
        u.name AS creator_name,
        u.avatar AS creator_avatar,
        t.created_at,
        t.updated_at
      FROM tr_daily_task t
      LEFT JOIN mst_department d ON d.department_id = t.department_id
      LEFT JOIN users u ON u.id = t.creator_id
      WHERE t.deleted_at IS NULL
        AND ${visibilitySql}
      ORDER BY t.created_at DESC
      LIMIT 200`,
      visibilityParams
    );

    const taskIds = tasks.map((t) => t.id);
    let evidenceMap = {};
    let linksMap = {};

    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");

      const [evidences] = await safeQuery(
        `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_at
         FROM tr_daily_evidence WHERE task_id IN (${placeholders})`,
        taskIds
      );
      evidences.forEach((ev) => {
        if (!evidenceMap[ev.task_id]) evidenceMap[ev.task_id] = [];
        evidenceMap[ev.task_id].push(ev);
      });

      const [links] = await safeQuery(
        `SELECT id, task_id, url, label FROM tr_daily_task_links WHERE task_id IN (${placeholders})`,
        taskIds
      );
      links.forEach((l) => {
        if (!linksMap[l.task_id]) linksMap[l.task_id] = [];
        linksMap[l.task_id].push(l);
      });
    }

    // Batch-fetch names for all target IDs across tasks
    const allCIds = [...new Set(tasks.flatMap((t) => parseJsonIds(t.target_company_ids)))].filter(Boolean);
    const allDIds = [...new Set(tasks.flatMap((t) => parseJsonIds(t.target_department_ids)))].filter(Boolean);
    const allEIds = [...new Set(tasks.flatMap((t) => parseJsonIds(t.target_employee_ids)))].filter(Boolean);
    const { companyMap, deptMap, empMap } = await fetchTargetNames(allCIds, allDIds, allEIds);

    const result = tasks.map((t) => ({
      ...enrichTask(t, companyMap, deptMap, empMap),
      evidences: evidenceMap[t.id] || [],
      links: linksMap[t.id] || [],
    }));

    return res.json({ tasks: result });
  } catch (err) {
    console.error("[dailyTask] getTasks error:", err);
    return res.status(500).json({ message: "Gagal mengambil data task" });
  }
};

// ─── CREATE TASK ─────────────────────────────────────────────────────────────
export const createTask = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const {
      title, description, department_id, is_public, links,
      target_company_ids, target_department_ids, target_employee_ids,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title wajib diisi" });
    }

    const publicFlag = is_public === "0" ? 0 : 1;

    const [result] = await safeQuery(
      `INSERT INTO tr_daily_task
        (title, description, department_id, is_public, creator_id,
         target_company_ids, target_department_ids, target_employee_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(),
        description || null,
        department_id || null,
        publicFlag,
        userId,
        toJsonIds(target_company_ids),
        toJsonIds(target_department_ids),
        toJsonIds(target_employee_ids),
      ]
    );

    const taskId = result.insertId;

    // Simpan links
    let parsedLinks = [];
    try { if (links) parsedLinks = JSON.parse(links); } catch {}
    for (const link of parsedLinks) {
      if (link.url?.trim()) {
        await safeQuery(
          `INSERT INTO tr_daily_task_links (task_id, url, label) VALUES (?, ?, ?)`,
          [taskId, link.url.trim(), link.label?.trim() || null]
        );
      }
    }

    // Simpan evidence
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const relativePath = `daily_evidence/${file.filename}`;
        await safeQuery(
          `INSERT INTO tr_daily_evidence (task_id, file_name, file_path, file_type, file_size)
           VALUES (?, ?, ?, ?, ?)`,
          [taskId, file.originalname, relativePath, file.mimetype, file.size]
        );
      }
    }

    const [newTaskRows] = await safeQuery(
      `SELECT t.*, u.name AS creator_name, u.avatar AS creator_avatar, d.department_name
       FROM tr_daily_task t
       LEFT JOIN users u ON u.id = t.creator_id
       LEFT JOIN mst_department d ON d.department_id = t.department_id
       WHERE t.id = ?`,
      [taskId]
    );
    const [evidences] = await safeQuery(`SELECT * FROM tr_daily_evidence WHERE task_id = ?`, [taskId]);
    const [savedLinks] = await safeQuery(
      `SELECT id, task_id, url, label FROM tr_daily_task_links WHERE task_id = ?`, [taskId]
    );

    const task = newTaskRows[0];
    const cIds = parseJsonIds(task.target_company_ids);
    const dIds = parseJsonIds(task.target_department_ids);
    const eIds = parseJsonIds(task.target_employee_ids);
    const { companyMap, deptMap, empMap } = await fetchTargetNames(cIds, dIds, eIds);

    return res.status(201).json({
      message: "Task berhasil dibuat",
      task: { ...enrichTask(task, companyMap, deptMap, empMap), evidences, links: savedLinks },
    });
  } catch (err) {
    console.error("[dailyTask] createTask error:", err);
    return res.status(500).json({ message: "Gagal membuat task" });
  }
};

// ─── UPDATE TASK ─────────────────────────────────────────────────────────────
export const updateTask = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    const [rows] = await safeQuery(
      `SELECT creator_id FROM tr_daily_task WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Task tidak ditemukan" });

    const [roleRows] = await safeQuery(`SELECT role FROM users WHERE id = ?`, [userId]);
    const isAdmin = ["superadmin", "admin", "manager"].includes(roleRows[0]?.role);
    if (rows[0].creator_id !== Number(userId) && !isAdmin) {
      return res.status(403).json({ message: "Tidak punya akses edit task ini" });
    }

    const {
      title, description, department_id, is_public, links, deleted_evidence_ids,
      target_company_ids, target_department_ids, target_employee_ids,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title wajib diisi" });
    }

    const publicFlag = is_public === "0" ? 0 : 1;

    await safeQuery(
      `UPDATE tr_daily_task SET
        title = ?, description = ?, department_id = ?, is_public = ?,
        target_company_ids = ?, target_department_ids = ?, target_employee_ids = ?
       WHERE id = ?`,
      [
        title.trim(),
        description || null,
        department_id || null,
        publicFlag,
        toJsonIds(target_company_ids),
        toJsonIds(target_department_ids),
        toJsonIds(target_employee_ids),
        id,
      ]
    );

    // Hapus evidence yang diminta
    if (deleted_evidence_ids) {
      try {
        const idsToDelete = JSON.parse(deleted_evidence_ids);
        if (Array.isArray(idsToDelete) && idsToDelete.length > 0) {
          for (const evId of idsToDelete) {
            const [evRows] = await safeQuery(
              `SELECT file_path FROM tr_daily_evidence WHERE id = ? AND task_id = ?`,
              [evId, id]
            );
            if (evRows.length > 0) {
              const fullPath = path.join(ASSETS_BASE, evRows[0].file_path);
              if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
            }
          }
          const placeholders = idsToDelete.map(() => "?").join(",");
          await safeQuery(
            `DELETE FROM tr_daily_evidence WHERE id IN (${placeholders}) AND task_id = ?`,
            [...idsToDelete, id]
          );
        }
      } catch (parseErr) {
        console.warn("[dailyTask] Failed to parse deleted_evidence_ids:", parseErr);
      }
    }

    // Tambah evidence baru
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const relativePath = `daily_evidence/${file.filename}`;
        await safeQuery(
          `INSERT INTO tr_daily_evidence (task_id, file_name, file_path, file_type, file_size)
           VALUES (?, ?, ?, ?, ?)`,
          [id, file.originalname, relativePath, file.mimetype, file.size]
        );
      }
    }

    // Replace semua links (hapus lama, insert baru)
    await safeQuery(`DELETE FROM tr_daily_task_links WHERE task_id = ?`, [id]);
    let parsedLinks = [];
    try { if (links) parsedLinks = JSON.parse(links); } catch {}
    for (const link of parsedLinks) {
      if (link.url?.trim()) {
        await safeQuery(
          `INSERT INTO tr_daily_task_links (task_id, url, label) VALUES (?, ?, ?)`,
          [id, link.url.trim(), link.label?.trim() || null]
        );
      }
    }

    const [updated] = await safeQuery(
      `SELECT t.*, u.name AS creator_name, u.avatar AS creator_avatar, d.department_name
       FROM tr_daily_task t
       LEFT JOIN users u ON u.id = t.creator_id
       LEFT JOIN mst_department d ON d.department_id = t.department_id
       WHERE t.id = ?`,
      [id]
    );
    const [evidences] = await safeQuery(
      `SELECT * FROM tr_daily_evidence WHERE task_id = ?`, [id]
    );
    const [savedLinks] = await safeQuery(
      `SELECT id, task_id, url, label FROM tr_daily_task_links WHERE task_id = ?`, [id]
    );

    const task = updated[0];
    const cIds = parseJsonIds(task.target_company_ids);
    const dIds = parseJsonIds(task.target_department_ids);
    const eIds = parseJsonIds(task.target_employee_ids);
    const { companyMap, deptMap, empMap } = await fetchTargetNames(cIds, dIds, eIds);

    return res.json({
      message: "Task berhasil diupdate",
      task: { ...enrichTask(task, companyMap, deptMap, empMap), evidences, links: savedLinks },
    });
  } catch (err) {
    console.error("[dailyTask] updateTask error:", err);
    return res.status(500).json({ message: "Gagal mengupdate task" });
  }
};

// ─── DELETE TASK (Soft) ───────────────────────────────────────────────────────
export const deleteTask = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { id } = req.params;

    const [rows] = await safeQuery(
      `SELECT creator_id FROM tr_daily_task WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Task tidak ditemukan" });

    const [roleRows] = await safeQuery(`SELECT role FROM users WHERE id = ?`, [userId]);
    const isAdmin = ["superadmin", "admin", "manager"].includes(roleRows[0]?.role);
    if (rows[0].creator_id !== Number(userId) && !isAdmin) {
      return res.status(403).json({ message: "Tidak punya akses hapus task ini" });
    }

    await safeQuery(`UPDATE tr_daily_task SET deleted_at = NOW() WHERE id = ?`, [id]);

    return res.json({ message: "Task berhasil dihapus" });
  } catch (err) {
    console.error("[dailyTask] deleteTask error:", err);
    return res.status(500).json({ message: "Gagal menghapus task" });
  }
};

// ─── GET DEPARTMENTS ─────────────────────────────────────────────────────────
export const getDepartments = async (_req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT department_id, department_name FROM mst_department ORDER BY department_name ASC`,
      []
    );
    return res.json({ departments: rows });
  } catch (err) {
    console.error("[dailyTask] getDepartments error:", err);
    return res.status(500).json({ message: "Gagal mengambil department" });
  }
};

// ─── GET COMPANIES ────────────────────────────────────────────────────────────
export const getCompanies = async (_req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT company_id, company_name FROM mst_company WHERE is_active = 1 ORDER BY company_name ASC`,
      []
    );
    return res.json({ companies: rows });
  } catch (err) {
    console.error("[dailyTask] getCompanies error:", err);
    return res.status(500).json({ message: "Gagal mengambil data perusahaan" });
  }
};

// ─── GET EMPLOYEES (with optional search, limit 100) ─────────────────────────
export const getEmployees = async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    let q = `SELECT employee_id, full_name, employee_code
             FROM mst_employee WHERE is_deleted = 0`;
    const params = [];
    if (search) {
      q += " AND (full_name LIKE ? OR employee_code LIKE ?)";
      params.push(`%${search}%`, `%${search}%`);
    }
    q += " ORDER BY full_name ASC LIMIT 100";
    const [rows] = await safeQuery(q, params);
    return res.json({ employees: rows });
  } catch (err) {
    console.error("[dailyTask] getEmployees error:", err);
    return res.status(500).json({ message: "Gagal mengambil data karyawan" });
  }
};