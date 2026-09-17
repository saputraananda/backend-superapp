import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getSessionList,
	approveSupervisor,
	rejectSupervisor,
	uploadBodAttachment,
	uploadBodMiddleware,
} from "../../controllers/Alora/attendanceSessionAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getSessionList);
router.post("/:id/bod-attachment", requireAuth, uploadBodMiddleware, uploadBodAttachment);
router.put("/:id/supervisor-approve", requireAuth, approveSupervisor);
router.put("/:id/supervisor-reject", requireAuth, rejectSupervisor);

export default router;
