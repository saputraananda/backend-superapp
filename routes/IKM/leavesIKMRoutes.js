import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getLeaves, approveLeave, rejectLeave } from "../../controllers/IKM/leavesIKMController.js";

const router = express.Router();

router.get("/", requireAuth, getLeaves);
router.put("/:id/approve", requireAuth, approveLeave);
router.put("/:id/reject", requireAuth, rejectLeave);

export default router;
