import pool from "../db/pool.js";

const roleRank = { employee: 1, hr: 2, admin: 3 };

export const getApps = async (req, res) => {
  const myRole = req.session.user.role ?? "employee";
  const [rows] = await pool.query(
    `SELECT id, name, description, href, min_role FROM mst_apps WHERE is_active = 1 ORDER BY sort_order ASC`
  );
  const filtered = rows.filter((a) => roleRank[myRole] >= roleRank[a.min_role]);
  res.json({ apps: filtered.map(({ min_role, ...x }) => x) });
};