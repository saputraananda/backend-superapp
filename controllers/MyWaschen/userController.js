import { safeMyWaschenQuery } from "../../db/pool.js";
import bcrypt from "bcrypt";

// GET /api/users -> Get all users (joined with roles and outlets)
export const getUsers = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT u.id, u.outlet_id, u.primary_role_id, u.name, u.username, u.email, u.phone, 
              u.employee_no, u.is_active, u.created_at,
              r.name as role_name, r.code as role_code,
              o.name as outlet_name
       FROM mst_user u
       LEFT JOIN mst_role r ON u.primary_role_id = r.id
       LEFT JOIN mst_outlet o ON u.outlet_id = o.id
       WHERE u.deleted_at IS NULL
       ORDER BY u.id DESC`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getUsers] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// POST /api/users/register -> Register a new user
export const registerUser = async (req, res) => {
  try {
    const { outlet_id, primary_role_id, name, username, email, phone, password, employee_no, pin } = req.body;

    if (!primary_role_id || !name || !username || !email || !password) {
      return res.status(400).json({ success: false, message: "Missing required fields." });
    }

    // Check duplicate username/email
    const [dup] = await safeMyWaschenQuery(
      "SELECT id FROM mst_user WHERE username = ? OR email = ?",
      [username, email]
    );
    if (dup.length > 0) {
      return res.status(400).json({ success: false, message: "Username or Email already registered." });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const pin_hash = pin ? await bcrypt.hash(pin, 10) : null;

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_user (outlet_id, primary_role_id, name, username, email, phone, password_hash, employee_no, pin_hash, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [outlet_id || null, primary_role_id, name, username, email, phone || null, password_hash, employee_no || null, pin_hash]
    );

    return res.json({ success: true, message: "User registered successfully", data: { id: result.insertId } });
  } catch (err) {
    console.error("[registerUser] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// PUT /api/users/:id -> Update user
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { outlet_id, primary_role_id, name, username, email, phone, password, employee_no, pin, is_active } = req.body;

    const [existing] = await safeMyWaschenQuery("SELECT id FROM mst_user WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // Check duplicates
    if (username || email) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_user WHERE (username = ? OR email = ?) AND id != ?",
        [username, email, id]
      );
      if (dup.length > 0) {
        return res.status(400).json({ success: false, message: "Username or Email already in use." });
      }
    }

    let passwordUpdateSql = "";
    const params = [];
    
    let password_hash = null;
    if (password) {
      password_hash = await bcrypt.hash(password, 10);
    }
    
    let pin_hash = null;
    if (pin) {
      pin_hash = await bcrypt.hash(pin, 10);
    }

    await safeMyWaschenQuery(
      `UPDATE mst_user 
       SET outlet_id = COALESCE(?, outlet_id),
           primary_role_id = COALESCE(?, primary_role_id),
           name = COALESCE(?, name),
           username = COALESCE(?, username),
           email = COALESCE(?, email),
           phone = ?,
           password_hash = COALESCE(?, password_hash),
           employee_no = ?,
           pin_hash = COALESCE(?, pin_hash),
           is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [outlet_id, primary_role_id, name, username, email, phone, password_hash, employee_no, pin_hash, is_active, id]
    );

    return res.json({ success: true, message: "User updated successfully" });
  } catch (err) {
    console.error("[updateUser] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// DELETE /api/users/:id -> Soft delete user
export const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.session.userId || 1;

    await safeMyWaschenQuery(
      "UPDATE mst_user SET deleted_at = NOW(), deleted_by = ?, is_active = 0 WHERE id = ?",
      [adminId, id]
    );
    return res.json({ success: true, message: "User soft-deleted successfully" });
  } catch (err) {
    console.error("[deleteUser] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/users/roles -> List all roles for user creation
export const getRoles = async (req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      "SELECT id, code, name FROM mst_role WHERE is_active = 1"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[getRoles] Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
