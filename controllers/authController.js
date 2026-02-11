import bcrypt from "bcrypt";
import pool from "../db/pool.js";

export const register = async (req, res) => {
  const { name, email, password, role = "admin" } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: "Invalid input" });

  const hash = await bcrypt.hash(password, 10);
  try {
    const [result] = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [name, email, hash, role]
    );
    res.json({ id: result.insertId, name, email, role });
  } catch {
    res.status(400).json({ message: "Email already used" });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;
  const [rows] = await pool.query(`SELECT * FROM users WHERE email = ? LIMIT 1`, [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.json({ user: req.session.user });
};

export const logout = (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("alora.sid");
    res.json({ ok: true });
  });
};

export const me = (req, res) => {
  res.json({ user: req.session.user ?? null });
};