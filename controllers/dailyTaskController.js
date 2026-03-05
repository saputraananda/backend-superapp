import path from "path";
import fs from "fs";
import { safeQuery } from "../db/pool.js";

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/storage/assets"
  : path.join(process.cwd(), "assets");

// ─── GET ALL TASKS ───────────────────────────────────────────────────────────
export const getTasks = async (req, res) => {
  try {
    const [tasks] = await safeQuery(
      `SELECT 
        t.id,
        t.title,
        t.description,
        t.department_id,
        d.department_name,        
        t.link_url,
        t.is_recurring,
        t.recur_type,
        t.recur_day,
        t.creator_id,
        u.name AS creator_name,
        u.avatar AS creator_avatar,
        t.created_at,
        t.updated_at
      FROM tr_daily_task t
      LEFT JOIN mst_department d ON d.department_id = t.department_id
      LEFT JOIN users u ON u.id = t.creator_id
      WHERE t.deleted_at IS NULL
      ORDER BY t.created_at DESC
      LIMIT 50`,
      []
    );

    const taskIds = tasks.map((t) => t.id);
    let evidenceMap = {};
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const [evidences] = await safeQuery(
        `SELECT id, task_id, file_name, file_path, file_type, file_size, uploaded_at
         FROM tr_daily_evidence
         WHERE task_id IN (${placeholders})`,
        taskIds
      );
      evidences.forEach((ev) => {
        if (!evidenceMap[ev.task_id]) evidenceMap[ev.task_id] = [];
        evidenceMap[ev.task_id].push(ev);
      });
    }

    const result = tasks.map((t) => ({
      ...t,
      evidences: evidenceMap[t.id] || [],
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

    // req.body sudah di-parse oleh multer (multipart/form-data)
    const {
      title,
      description,
      department_id,
      link_url,
      is_recurring,
      recur_type,
      recur_day,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title wajib diisi" });
    }

    const recurring = is_recurring === "1" || is_recurring === true;

    const [result] = await safeQuery(
      `INSERT INTO tr_daily_task 
        (title, description, department_id, link_url, is_recurring, recur_type, recur_day, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(),
        description || null,
        department_id || null,
        link_url?.trim() || null,
        recurring ? 1 : 0,
        recurring ? (recur_type || null) : null,
        recurring && recur_type === "weekly" ? (recur_day ?? null) : null,
        userId,
      ]
    );

    const taskId = result.insertId;

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

    // Return task lengkap dengan join department
    const [newTaskRows] = await safeQuery(
      `SELECT t.*, 
              u.name AS creator_name, 
              u.avatar AS creator_avatar,
              d.department_name
       FROM tr_daily_task t
       LEFT JOIN users u ON u.id = t.creator_id
       LEFT JOIN mst_department d ON d.department_id = t.department_id
       WHERE t.id = ?`,
      [taskId]
    );

    const [evidences] = await safeQuery(
      `SELECT * FROM tr_daily_evidence WHERE task_id = ?`,
      [taskId]
    );

    return res.status(201).json({
      message: "Task berhasil dibuat",
      task: { ...newTaskRows[0], evidences },
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
      `SELECT creator_id FROM tr_daily_task WHERE id = ? AND deleted_at IS NULL`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Task tidak ditemukan" });

    const [roleRows] = await safeQuery(`SELECT role FROM users WHERE id = ?`, [userId]);
    const isAdmin = ["superadmin", "admin", "manager"].includes(roleRows[0]?.role);
    if (rows[0].creator_id !== Number(userId) && !isAdmin) {
      return res.status(403).json({ message: "Tidak punya akses edit task ini" });
    }

    const {
      title,
      description,
      department_id,
      link_url,
      is_recurring,
      recur_type,
      recur_day,
      deleted_evidence_ids,
    } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title wajib diisi" });
    }

    const recurring = is_recurring === "1" || is_recurring === true;

    await safeQuery(
      `UPDATE tr_daily_task SET
        title = ?, description = ?, department_id = ?, link_url = ?,
        is_recurring = ?, recur_type = ?, recur_day = ?
       WHERE id = ?`,
      [
        title.trim(),
        description || null,
        department_id || null,
        link_url?.trim() || null,
        recurring ? 1 : 0,
        recurring ? (recur_type || null) : null,
        recurring && recur_type === "weekly" ? (recur_day ?? null) : null,
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

    const [updated] = await safeQuery(
      `SELECT t.*, 
              u.name AS creator_name, 
              u.avatar AS creator_avatar,
              d.department_name
       FROM tr_daily_task t
       LEFT JOIN users u ON u.id = t.creator_id
       LEFT JOIN mst_department d ON d.department_id = t.department_id
       WHERE t.id = ?`,
      [id]
    );

    const [evidences] = await safeQuery(
      `SELECT * FROM tr_daily_evidence WHERE task_id = ?`,
      [id]
    );

    return res.json({
      message: "Task berhasil diupdate",
      task: { ...updated[0], evidences },
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
      `SELECT creator_id FROM tr_daily_task WHERE id = ? AND deleted_at IS NULL`,
      [id]
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
      `SELECT department_id, department_name
       FROM mst_department 
       ORDER BY department_name ASC`,
      []
    );
    return res.json({ departments: rows });
  } catch (err) {
    console.error("[dailyTask] getDepartments error:", err);
    return res.status(500).json({ message: "Gagal mengambil department" });
  }
};