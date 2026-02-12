import pool from "../db/pool.js";

export const getApps = async (req, res) => {
  console.log("[API] /apps endpoint hit"); // Log saat API diakses

  const userId = req.session.userId;
  if (!userId) {
    return res.status(401).json({ message: "Unauthorized: not logged in" });
  }

  const [userRows] = await pool.query(
    "SELECT role FROM users WHERE id = ?",
    [userId]
  );
  if (userRows.length === 0) {
    return res.status(401).json({ message: "User not found" });
  }

  const myRole = userRows[0].role;

  const [apps] = await pool.query(
    `SELECT id, name, description, href, authorization, is_active 
     FROM mst_apps 
     WHERE is_active = 1 
     ORDER BY sort_order ASC`
  );

  const filteredApps = apps.filter(app => {
    if (!app.authorization) return false;
    const allowedRoles = app.authorization.split(",").map(r => r.trim());
    return allowedRoles.includes(myRole);
  });

  res.json({ apps: filteredApps });
};