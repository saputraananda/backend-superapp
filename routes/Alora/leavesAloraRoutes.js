import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getLeaves,
	approveSupervisor,
	rejectSupervisor,
	approveHRD,
	rejectHRD,
} from "../../controllers/Alora/leavesAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getLeaves);
router.put("/:id/supervisor-approve", requireAuth, approveSupervisor);
router.put("/:id/supervisor-reject", requireAuth, rejectSupervisor);
router.put("/:id/hrd-approve", requireAuth, approveHRD);
router.put("/:id/hrd-reject", requireAuth, rejectHRD);

export default router;
