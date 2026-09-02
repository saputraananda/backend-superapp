import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import { getLeaveList, approveLeave, rejectLeave } from "../../../controllers/MyWaschen/HRIS/LeaveController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getLeaveList);
router.patch("/:id/approve", approveLeave);
router.patch("/:id/reject", rejectLeave);
export default router;
