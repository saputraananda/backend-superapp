import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getPlannedLateList,
	approvePlannedLate,
	rejectPlannedLate,
} from "../../controllers/Alora/plannedLateAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getPlannedLateList);
router.put("/:attendanceId/supervisor-approve", requireAuth, approvePlannedLate);
router.put("/:attendanceId/supervisor-reject", requireAuth, rejectPlannedLate);

export default router;
