import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getTodayMood,
  saveMood,
  getMoodStats,
} from "../controllers/employeeMoodController.js";

const router = express.Router();

router.get("/today", requireAuth, getTodayMood);
router.post("/", requireAuth, saveMood);
router.get("/stats", requireAuth, getMoodStats);

export default router;
