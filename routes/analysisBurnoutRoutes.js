import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  validateKey,
  submitSurvey,
  getSurveyHistory,
} from "../controllers/analysisBurnoutController.js";

const router = express.Router();

// Semua route di sini butuh login
router.post("/verify-key", requireAuth, validateKey);
router.post("/submit", requireAuth, submitSurvey);
router.get("/history", requireAuth, getSurveyHistory);

export default router;
