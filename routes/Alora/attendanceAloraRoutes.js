import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getAttendanceReport,
	serveAttendancePhoto,
} from "../../controllers/Alora/attendanceAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getAttendanceReport);
router.get("/photos/:filename", requireAuth, serveAttendancePhoto);

export default router;
