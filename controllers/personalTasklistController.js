import path from "path";
import { safeQuery } from "../db/pool.js";

// ─── GET: All task lists visible to current user ─────────────────────────────
export const getTasklists = async (req, res) => {
  try {
    const userId = req.session?.userId;
    const employeeId = req.session?.employeeId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { company_id, date_from, date_to } = req.query;

    // Build WHERE conditions
    let extraWhere = "";
    const params = [userId, employeeId || 0];

    if (company_id) {
      extraWhere += " AND tl.company_id = ?";
      params.push(Number(company_id));
    }
    if (date_from) {
      extraWhere += " AND tl.due_date >= ?";
      params.push(date_from);
    }
    if (date_to) {
      extraWhere += " AND tl.due_date <= ?";
      params.push(date_to);
    }

    const [rows] = await safeQuery(
      `SELECT DISTINCT tl.id, tl.title, tl.description, tl.company_id, tl.due_date,
              tl.created_by, tl.created_at, tl.updated_at,
              u.name AS creator_name, c.company_name
       FROM tr_personal_tasklist tl
       LEFT JOIN users u ON u.id = tl.created_by
       LEFT JOIN mst_company c ON c.company_id = tl.company_id
       LEFT JOIN tr_personal_tasklist_assignees a ON a.tasklist_id = tl.id
       WHERE (tl.created_by = ? OR a.employee_id = ?)${extraWhere}
       ORDER BY tl.updated_at DESC`,
      params
    );

    // Fetch items + assignees for all tasklists
    const ids = rows.map((r) => r.id);
    let itemsMap = {};
    let assigneesMap = {};

    if (ids.length > 0) {
      const ph = ids.map(() => "?").join(",");

      const [items] = await safeQuery(
        `SELECT id, tasklist_id, content, is_checked, sort_order, evidence_type, evidence_value, created_at, updated_at
         FROM tr_personal_tasklist_items WHERE tasklist_id IN (${ph}) ORDER BY sort_order, id`,
        ids
      );
      items.forEach((it) => {
        if (!itemsMap[it.tasklist_id]) itemsMap[it.tasklist_id] = [];
        itemsMap[it.tasklist_id].push(it);
      });

      const [assignees] = await safeQuery(
        `SELECT a.tasklist_id, a.employee_id, e.full_name
         FROM tr_personal_tasklist_assignees a
         LEFT JOIN mst_employee e ON e.employee_id = a.employee_id
         WHERE a.tasklist_id IN (${ph})`,
        ids
      );
      assignees.forEach((a) => {
        if (!assigneesMap[a.tasklist_id]) assigneesMap[a.tasklist_id] = [];
        assigneesMap[a.tasklist_id].push(a);
      });
    }

    const result = rows.map((r) => {
      const items = itemsMap[r.id] || [];
      const total = items.length;
      const checked = items.filter((i) => i.is_checked).length;
      return {
        ...r,
        items,
        assignees: assigneesMap[r.id] || [],
        total_items: total,
        checked_items: checked,
        percentage: total > 0 ? Math.round((checked / total) * 100) : 0,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("[personalTasklist] getTasklists error:", err);
    res.status(500).json({ message: "Gagal mengambil data tasklist" });
  }
};

// ─── POST: Create task list ──────────────────────────────────────────────────
export const createTasklist = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { title, description, company_id, due_date, items, assignees } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

    const [result] = await safeQuery(
      "INSERT INTO tr_personal_tasklist (title, description, company_id, due_date, created_by) VALUES (?, ?, ?, ?, ?)",
      [title.trim(), description?.trim() || null, company_id || null, due_date || null, userId]
    );
    const tasklistId = result.insertId;

    // Insert items
    if (Array.isArray(items) && items.length > 0) {
      const values = items.map((it, i) => [tasklistId, it.content, it.is_checked ? 1 : 0, i, it.evidence_type || "none", it.evidence_value || null]);
      await safeQuery(
        "INSERT INTO tr_personal_tasklist_items (tasklist_id, content, is_checked, sort_order, evidence_type, evidence_value) VALUES ?",
        [values]
      );
    }

    // Insert assignees
    if (Array.isArray(assignees) && assignees.length > 0) {
      const uniqueIds = [...new Set(assignees.map(Number).filter(Boolean))];
      if (uniqueIds.length > 0) {
        const vals = uniqueIds.map((eid) => [tasklistId, eid]);
        await safeQuery("INSERT INTO tr_personal_tasklist_assignees (tasklist_id, employee_id) VALUES ?", [vals]);
      }
    }

    res.status(201).json({ message: "Tasklist berhasil dibuat", id: tasklistId });
  } catch (err) {
    console.error("[personalTasklist] createTasklist error:", err);
    res.status(500).json({ message: "Gagal membuat tasklist" });
  }
};

// ─── PUT: Update task list (title, description, items, assignees) ────────────
export const updateTasklist = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;

    // Only creator can update
    const [existing] = await safeQuery("SELECT id, created_by FROM tr_personal_tasklist WHERE id = ?", [id]);
    if (!existing.length) return res.status(404).json({ message: "Tasklist tidak ditemukan" });
    if (existing[0].created_by !== userId) return res.status(403).json({ message: "Hanya pembuat yang bisa mengedit" });

    const { title, description, company_id, due_date, items, assignees } = req.body;
    if (!title?.trim()) return res.status(400).json({ message: "Title wajib diisi" });

    await safeQuery(
      "UPDATE tr_personal_tasklist SET title = ?, description = ?, company_id = ?, due_date = ? WHERE id = ?",
      [title.trim(), description?.trim() || null, company_id || null, due_date || null, id]
    );

    // Replace items: delete old, insert new
    if (Array.isArray(items)) {
      await safeQuery("DELETE FROM tr_personal_tasklist_items WHERE tasklist_id = ?", [id]);
      if (items.length > 0) {
        const values = items.map((it, i) => [id, it.content, it.is_checked ? 1 : 0, i, it.evidence_type || "none", it.evidence_value || null]);
        await safeQuery(
          "INSERT INTO tr_personal_tasklist_items (tasklist_id, content, is_checked, sort_order, evidence_type, evidence_value) VALUES ?",
          [values]
        );
      }
    }

    // Replace assignees
    if (Array.isArray(assignees)) {
      await safeQuery("DELETE FROM tr_personal_tasklist_assignees WHERE tasklist_id = ?", [id]);
      const uniqueIds = [...new Set(assignees.map(Number).filter(Boolean))];
      if (uniqueIds.length > 0) {
        const vals = uniqueIds.map((eid) => [id, eid]);
        await safeQuery("INSERT INTO tr_personal_tasklist_assignees (tasklist_id, employee_id) VALUES ?", [vals]);
      }
    }

    res.json({ message: "Tasklist berhasil diperbarui" });
  } catch (err) {
    console.error("[personalTasklist] updateTasklist error:", err);
    res.status(500).json({ message: "Gagal memperbarui tasklist" });
  }
};

// ─── PATCH: Toggle single item checked ───────────────────────────────────────
export const toggleItem = async (req, res) => {
  try {
    const userId = req.session?.userId;
    const employeeId = req.session?.employeeId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { itemId } = req.params;
    const { is_checked } = req.body;

    // Verify user has access
    const [rows] = await safeQuery(
      `SELECT i.id, tl.created_by
       FROM tr_personal_tasklist_items i
       JOIN tr_personal_tasklist tl ON tl.id = i.tasklist_id
       LEFT JOIN tr_personal_tasklist_assignees a ON a.tasklist_id = tl.id AND a.employee_id = ?
       WHERE i.id = ? AND (tl.created_by = ? OR a.employee_id IS NOT NULL)`,
      [employeeId || 0, itemId, userId]
    );
    if (!rows.length) return res.status(404).json({ message: "Item tidak ditemukan" });

    await safeQuery(
      "UPDATE tr_personal_tasklist_items SET is_checked = ? WHERE id = ?",
      [is_checked ? 1 : 0, itemId]
    );

    res.json({ message: "Item diperbarui" });
  } catch (err) {
    console.error("[personalTasklist] toggleItem error:", err);
    res.status(500).json({ message: "Gagal update item" });
  }
};

// ─── DELETE: Delete task list ────────────────────────────────────────────────
export const deleteTasklist = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const { id } = req.params;

    const [existing] = await safeQuery("SELECT id, created_by FROM tr_personal_tasklist WHERE id = ?", [id]);
    if (!existing.length) return res.status(404).json({ message: "Tasklist tidak ditemukan" });
    if (existing[0].created_by !== userId) return res.status(403).json({ message: "Hanya pembuat yang bisa menghapus" });

    await safeQuery("DELETE FROM tr_personal_tasklist WHERE id = ?", [id]);
    res.json({ message: "Tasklist berhasil dihapus" });
  } catch (err) {
    console.error("[personalTasklist] deleteTasklist error:", err);
    res.status(500).json({ message: "Gagal menghapus tasklist" });
  }
};

// ─── POST: Upload evidence file for an item ──────────────────────────────────
export const uploadItemEvidence = async (req, res) => {
  try {
    const userId = req.session?.userId;
    const employeeId = req.session?.employeeId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { itemId } = req.params;

    // Verify access
    const [rows] = await safeQuery(
      `SELECT i.id, tl.created_by
       FROM tr_personal_tasklist_items i
       JOIN tr_personal_tasklist tl ON tl.id = i.tasklist_id
       LEFT JOIN tr_personal_tasklist_assignees a ON a.tasklist_id = tl.id AND a.employee_id = ?
       WHERE i.id = ? AND (tl.created_by = ? OR a.employee_id IS NOT NULL)`,
      [employeeId || 0, itemId, userId]
    );
    if (!rows.length) return res.status(404).json({ message: "Item tidak ditemukan" });

    if (!req.file) return res.status(400).json({ message: "File tidak ditemukan" });

    const filePath = `tasklist_evidence/${req.file.filename}`;
    await safeQuery(
      "UPDATE tr_personal_tasklist_items SET evidence_type = 'file', evidence_value = ? WHERE id = ?",
      [filePath, itemId]
    );

    res.json({ message: "Evidence berhasil diupload", evidence_value: filePath });
  } catch (err) {
    console.error("[personalTasklist] uploadItemEvidence error:", err);
    res.status(500).json({ message: "Gagal upload evidence" });
  }
};

// ─── POST: Upload evidence file (general, returns path) ─────────────────────
export const uploadEvidence = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!req.file) return res.status(400).json({ message: "File tidak ditemukan" });

    const filePath = `tasklist_evidence/${req.file.filename}`;
    res.json({ message: "File berhasil diupload", evidence_value: filePath, file_name: req.file.originalname });
  } catch (err) {
    console.error("[personalTasklist] uploadEvidence error:", err);
    res.status(500).json({ message: "Gagal upload file" });
  }
};

// ─── GET: Companies for dropdown ─────────────────────────────────────────────
export const getCompanies = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await safeQuery(
      "SELECT company_id, company_name FROM mst_company WHERE is_active = 1 ORDER BY company_name"
    );
    res.json(rows);
  } catch (err) {
    console.error("[personalTasklist] getCompanies error:", err);
    res.status(500).json({ message: "Gagal mengambil data perusahaan" });
  }
};

// ─── GET: Search employees for assignee picker ───────────────────────────────
export const searchEmployees = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const q = req.query.q || "";
    const [rows] = await safeQuery(
      `SELECT employee_id, full_name, employee_code
       FROM mst_employee
       WHERE is_deleted = 0 AND exit_date IS NULL AND full_name LIKE ?
       ORDER BY full_name
       LIMIT 200`,
      [`%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error("[personalTasklist] searchEmployees error:", err);
    res.status(500).json({ message: "Gagal mencari karyawan" });
  }
};
