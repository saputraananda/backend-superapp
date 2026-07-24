import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getAllEmployeeMoods,
  getTodayTeamMood,
  getMoodSummary,
  getEmployeeMoodHistory,
  getMostFrequentMoodEmployees,
} from "../controllers/knowYourEmpController.js";

const router = express.Router();

// GET semua mood karyawan (paginasi + filter)
router.get("/mood", requireAuth, getAllEmployeeMoods);

// GET mood tim hari ini
router.get("/mood/today", requireAuth, getTodayTeamMood);

// GET statistik / ringkasan mood bulanan
router.get("/mood/summary", requireAuth, getMoodSummary);

// GET karyawan paling sering mood tertentu (all time)
router.get("/mood/most-frequent", requireAuth, getMostFrequentMoodEmployees);

// GET riwayat mood 1 karyawan
router.get("/mood/:employeeId", requireAuth, getEmployeeMoodHistory);

export default router;
