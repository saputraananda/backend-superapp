import { safeQuery } from "../db/pool.js";
import bcrypt from "bcrypt";

const ALLOWED_ROLES = ["bod", "finance", "spv_hr", "hr", "spv_bdsm", "admin", "employee", "unauthorized"];

// ── GET ALL USERS ──────────────────────────────────────────────────────────
export async function getUsers(req, res) {
  try {
    const [rows] = await safeQuery(
      `SELECT id, name, email, username, role, created_at, updated_at
       FROM users
       ORDER BY created_at DESC`
    );
    res.json({ users: rows });
  } catch (error) {
    console.error("getUsers error:", error);
    res.status(500).json({ message: error.message });
  }
}

// ── GET USER BY ID ─────────────────────────────────────────────────────────
export async function getUserById(req, res) {
  const { id } = req.params;
  try {
    const [rows] = await safeQuery(
      `SELECT id, name, email, username, role, created_at, updated_at
       FROM users WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });
    res.json({ user: rows[0] });
  } catch (error) {
    console.error("getUserById error:", error);
    res.status(500).json({ message: error.message });
  }
}

// ── CREATE USER ────────────────────────────────────────────────────────────
export async function createUser(req, res) {
  const { name, email, username, password, role } = req.body;

  if (!name)     return res.status(400).json({ message: "Nama wajib diisi" });
  if (!email)    return res.status(400).json({ message: "Email wajib diisi" });
  if (!password) return res.status(400).json({ message: "Password wajib diisi" });
  if (!role || !ALLOWED_ROLES.includes(role))
    return res.status(400).json({ message: "Role tidak valid" });

  try {
    // Cek email duplikat
    const [existEmail] = await safeQuery(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existEmail.length > 0)
      return res.status(409).json({ message: "Email sudah terdaftar" });

    // Cek username duplikat
    if (username) {
      const [existUser] = await safeQuery(`SELECT id FROM users WHERE username = ?`, [username]);
      if (existUser.length > 0)
        return res.status(409).json({ message: "Username sudah dipakai" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await safeQuery(
      `INSERT INTO users (name, email, username, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [name, email, username || null, password_hash, role]
    );

    // Insert ke mst_employee
    await safeQuery(
      `INSERT INTO mst_employee (full_name, email) VALUES (?, ?)`,
      [name, email]
    );

    res.status(201).json({ message: "User berhasil ditambahkan", id: result.insertId });
  } catch (error) {
    console.error("createUser error:", error);
    res.status(500).json({ message: error.message });
  }
}

// ── UPDATE USER ────────────────────────────────────────────────────────────
export async function updateUser(req, res) {
  const { id } = req.params;
  const { name, email, username, password, role } = req.body;

  if (!name)  return res.status(400).json({ message: "Nama wajib diisi" });
  if (!email) return res.status(400).json({ message: "Email wajib diisi" });
  if (!role || !ALLOWED_ROLES.includes(role))
    return res.status(400).json({ message: "Role tidak valid" });

  try {
    // Cek user ada
    const [exist] = await safeQuery(`SELECT id, email FROM users WHERE id = ?`, [id]);
    if (exist.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });

    const oldEmail = exist[0].email;

    // Cek email duplikat (exclude diri sendiri)
    const [existEmail] = await safeQuery(
      `SELECT id FROM users WHERE email = ? AND id != ?`, [email, id]
    );
    if (existEmail.length > 0)
      return res.status(409).json({ message: "Email sudah dipakai user lain" });

    // Cek username duplikat
    if (username) {
      const [existUser] = await safeQuery(
        `SELECT id FROM users WHERE username = ? AND id != ?`, [username, id]
      );
      if (existUser.length > 0)
        return res.status(409).json({ message: "Username sudah dipakai user lain" });
    }

    // Update password jika diisi
    if (password && password.trim() !== "") {
      const password_hash = await bcrypt.hash(password, 10);
      await safeQuery(
        `UPDATE users SET name=?, email=?, username=?, password_hash=?, role=?, updated_at=NOW()
         WHERE id=?`,
        [name, email, username || null, password_hash, role, id]
      );
    } else {
      await safeQuery(
        `UPDATE users SET name=?, email=?, username=?, role=?, updated_at=NOW()
         WHERE id=?`,
        [name, email, username || null, role, id]
      );
    }

    // Sync mst_employee jika email berubah
    await safeQuery(
      `UPDATE mst_employee SET full_name=?, email=? WHERE email=?`,
      [name, email, oldEmail]
    );

    res.json({ message: "User berhasil diperbarui" });
  } catch (error) {
    console.error("updateUser error:", error);
    res.status(500).json({ message: error.message });
  }
}

// ── DELETE USER ────────────────────────────────────────────────────────────
export async function deleteUser(req, res) {
  const { id } = req.params;
  try {
    const [exist] = await safeQuery(`SELECT id, email FROM users WHERE id = ?`, [id]);
    if (exist.length === 0) return res.status(404).json({ message: "User tidak ditemukan" });

    await safeQuery(`DELETE FROM users WHERE id = ?`, [id]);

    res.json({ message: "User berhasil dihapus" });
  } catch (error) {
    console.error("deleteUser error:", error);
    res.status(500).json({ message: error.message });
  }
}