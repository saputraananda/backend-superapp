import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getManagementAttendance,
	updateManagementAttendance,
	deleteManagementAttendance,
	createManagementAttendance,
} from "../../controllers/IKM/absensiManajemenIKMController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Management Attendance API" });
});

router.get("/management", requireAuth, getManagementAttendance);
router.post("/management", requireAuth, createManagementAttendance);
router.put("/management/:id", requireAuth, updateManagementAttendance);
router.delete("/management/:id", requireAuth, deleteManagementAttendance);

export default router;
