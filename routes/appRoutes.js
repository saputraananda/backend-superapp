import express from "express";
import pool from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js"; // ← Import middleware

const router = express.Router();

router.get("/", requireAuth, async (req, res) => { // ← Pakai middleware
  try {
    const [rows] = await pool.query(
      "SELECT * FROM mst_apps WHERE is_active = 1 ORDER BY sort_order ASC"
    );
    res.json({ apps: rows });
  } catch (error) {
    console.error("Get apps error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;