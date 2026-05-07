import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getAttendanceShiftIKM,
	streamAttendanceShiftIKM,
	getEmployeeLeaveAndLateResume,
	updateAttendanceShiftIKM,
	createAttendanceShiftIKM,
} from "../../controllers/IKM/absensiIKMController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Attendance API" });
});

router.get("/stream", requireAuth, streamAttendanceShiftIKM);
router.get("/shifts", requireAuth, getAttendanceShiftIKM);
router.get("/employee-leave-resume", requireAuth, getEmployeeLeaveAndLateResume);
router.post("/shifts", requireAuth, createAttendanceShiftIKM);
router.put("/shifts/:id", requireAuth, updateAttendanceShiftIKM);

export default router;
