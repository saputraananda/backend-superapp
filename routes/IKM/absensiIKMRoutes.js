import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getAttendanceShiftIKM } from "../../controllers/IKM/absensiIKMController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Attendance API" });
});

router.get("/shifts", requireAuth, getAttendanceShiftIKM);

export default router;
