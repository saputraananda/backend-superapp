// controllers/ProjectManagement/personalChatController.js
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

// ─── CONTROLLER FUNCTIONS ──────────────────────────────────────────────────────

/**
 * GET /api/pm2/chat/contacts
 * Mengambil daftar rekan kerja di perusahaan yang sama beserta unread & last message info
 */
export async function listChatContacts(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const [rows] = await db.query(
      `SELECT
         e.employee_id AS id,
         e.full_name AS name,
         e.email,
         COALESCE(jl.job_level_name, 'Staff') AS role,
         (
           SELECT message
           FROM tr_projectmanagement_personal_chat
           WHERE is_deleted = 0
             AND ((sender_id = ? AND recipient_id = e.employee_id)
                  OR (sender_id = e.employee_id AND recipient_id = ?))
           ORDER BY created_at DESC
           LIMIT 1
         ) AS lastMsg,
         (
           SELECT created_at
           FROM tr_projectmanagement_personal_chat
           WHERE is_deleted = 0
             AND ((sender_id = ? AND recipient_id = e.employee_id)
                  OR (sender_id = e.employee_id AND recipient_id = ?))
           ORDER BY created_at DESC
           LIMIT 1
         ) AS lastMsgTime,
         (
           SELECT COUNT(*)
           FROM tr_projectmanagement_personal_chat
           WHERE is_deleted = 0
             AND sender_id = e.employee_id
             AND recipient_id = ?
             AND is_read = 0
         ) AS unread
       FROM mst_employee e
       LEFT JOIN mst_job_level jl ON jl.job_level_id = e.job_level_id
       WHERE e.company_id = ?
         AND e.employee_id != ?
         AND e.is_deleted = 0
       ORDER BY lastMsgTime DESC, name ASC`,
      [
        emp.employee_id, emp.employee_id,
        emp.employee_id, emp.employee_id,
        emp.employee_id,
        emp.company_id,
        emp.employee_id
      ]
    );

    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * GET /api/pm2/chat/messages/:contactId
 * Mengambil log pesan percakapan antara user dan contactId
 */
export async function listChatMessages(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { contactId } = req.params;
    if (!contactId) return res.status(400).json({ message: "Contact ID wajib disertakan" });

    // Menandai pesan yang masuk dari contactId ke user sebagai dibaca
    await db.query(
      `UPDATE tr_projectmanagement_personal_chat
       SET is_read = 1
       WHERE sender_id = ? AND recipient_id = ? AND is_read = 0 AND is_deleted = 0`,
      [contactId, emp.employee_id]
    );

    const [rows] = await db.query(
      `SELECT
         id,
         sender_id,
         recipient_id,
         message AS text,
         is_read,
         created_at AS time
       FROM tr_projectmanagement_personal_chat
       WHERE is_deleted = 0
         AND ((sender_id = ? AND recipient_id = ?)
              OR (sender_id = ? AND recipient_id = ?))
       ORDER BY created_at ASC`,
      [emp.employee_id, contactId, contactId, emp.employee_id]
    );

    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * POST /api/pm2/chat/messages
 * Mengirim pesan baru
 */
export async function sendChatMessage(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const emp = await getSessionEmployee(req);
    if (!emp) return res.status(401).json({ message: "Unauthorized" });

    const { recipient_id, message } = req.body;
    if (!recipient_id) return res.status(400).json({ message: "Recipient ID wajib disertakan" });
    if (!message || !message.trim()) return res.status(400).json({ message: "Pesan tidak boleh kosong" });

    const [insertResult] = await db.query(
      `INSERT INTO tr_projectmanagement_personal_chat (sender_id, recipient_id, message)
       VALUES (?, ?, ?)`,
      [emp.employee_id, recipient_id, message.trim()]
    );

    const [newMsgRows] = await db.query(
      `SELECT
         id,
         sender_id,
         recipient_id,
         message AS text,
         is_read,
         created_at AS time
       FROM tr_projectmanagement_personal_chat
       WHERE id = ?`,
      [insertResult.insertId]
    );

    res.status(201).json({ data: newMsgRows[0] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
