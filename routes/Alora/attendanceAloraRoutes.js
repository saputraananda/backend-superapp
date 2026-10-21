import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getAttendanceReport,
	serveAttendancePhoto,
	getActiveAloraAttendanceEmployees,
	createManualAttendance,
	updateManualAttendance,
	deleteManualAttendance,
} from "../../controllers/Alora/attendanceAloraController.js";
import {
	getPendingApprovals,
	uploadBodAttachment,
	approveSupervisor,
	rejectSupervisor,
	bodUploadMiddleware,
} from "../../controllers/Alora/attendanceApprovalAloraController.js";

const router = express.Router();

router.get("/pending-approvals", requireAuth, getPendingApprovals);
router.get("/photos/:filename", requireAuth, serveAttendancePhoto);
router.get("/active-employees", requireAuth, getActiveAloraAttendanceEmployees);
router.post("/manual", requireAuth, createManualAttendance);
router.put("/:id/manual", requireAuth, updateManualAttendance);
router.delete("/:id/manual", requireAuth, deleteManualAttendance);
router.get("/", requireAuth, getAttendanceReport);
router.post("/:id/bod-attachment", requireAuth, bodUploadMiddleware, uploadBodAttachment);
router.post("/:id/approve-supervisor", requireAuth, approveSupervisor);
router.post("/:id/reject-supervisor", requireAuth, rejectSupervisor);

export default router;

