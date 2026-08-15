import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getLeaves,
	approveLeave,
	rejectLeave,
	serveDoctorNote,
} from "../../controllers/Cleanox/leavesCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, getLeaves);
router.put("/:id/approve", requireAuth, approveLeave);
router.put("/:id/reject", requireAuth, rejectLeave);
router.get("/doctor-notes/:filename", requireAuth, serveDoctorNote);

export default router;
