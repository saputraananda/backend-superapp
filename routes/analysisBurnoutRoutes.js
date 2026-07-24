import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  validateKey,
  submitSurvey,
  getSurveyHistory,
  getBurnoutMonitoringList,
  getBurnoutMonitoringDetail,
  getBurnoutDashboardStats,
} from "../controllers/analysisBurnoutController.js";

const router = express.Router();

// Semua route di sini butuh login
router.post("/verify-key", requireAuth, validateKey);
router.post("/submit", requireAuth, submitSurvey);
router.get("/history", requireAuth, getSurveyHistory);
router.get("/dashboard-stats", requireAuth, getBurnoutDashboardStats);
router.get("/monitoring", requireAuth, getBurnoutMonitoringList);
router.get("/monitoring/:id", requireAuth, getBurnoutMonitoringDetail);

export default router;
