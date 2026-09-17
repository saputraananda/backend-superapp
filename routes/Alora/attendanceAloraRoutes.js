import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getAttendanceReport,
	serveAttendancePhoto,
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
router.get("/", requireAuth, getAttendanceReport);
router.post("/:id/bod-attachment", requireAuth, bodUploadMiddleware, uploadBodAttachment);
router.post("/:id/approve-supervisor", requireAuth, approveSupervisor);
router.post("/:id/reject-supervisor", requireAuth, rejectSupervisor);

export default router;
