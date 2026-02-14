import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  checkSurveyStatus,
  getSurveyMasterData,
  submitSurvey,
  getSurveyStats,
} from "../controllers/satisfactionController.js";

const router = express.Router();

// Routes
router.get("/status", requireAuth, checkSurveyStatus);
router.get("/master-data", requireAuth, getSurveyMasterData);
router.post("/submit", requireAuth, submitSurvey);
router.get("/stats", requireAuth, getSurveyStats);

export default router;