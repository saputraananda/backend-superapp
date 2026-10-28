import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getPiutangDashboardCleanox,
  recordPiutangReminder,
  cancelPiutangReminder,
} from "../../controllers/Cleanox/piutangDashboardCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, getPiutangDashboardCleanox);
router.post("/remind", requireAuth, recordPiutangReminder);
router.post("/unremind", requireAuth, cancelPiutangReminder);

export default router;
