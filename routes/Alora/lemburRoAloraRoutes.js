import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getLemburRoList,
	approveSupervisor,
	rejectSupervisor,
	approveHRD,
	rejectHRD,
} from "../../controllers/Alora/lemburRoAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getLemburRoList);
router.put("/:id/supervisor-approve", requireAuth, approveSupervisor);
router.put("/:id/supervisor-reject", requireAuth, rejectSupervisor);
router.put("/:id/hrd-approve", requireAuth, approveHRD);
router.put("/:id/hrd-reject", requireAuth, rejectHRD);

export default router;
