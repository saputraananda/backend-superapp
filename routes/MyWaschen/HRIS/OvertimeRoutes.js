import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getOvertimeList,
  getOvertimeDetail,
  approveOvertime,
  rejectOvertime,
} from "../../../controllers/MyWaschen/HRIS/OvertimeController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getOvertimeList);
router.get("/:id", getOvertimeDetail);
router.patch("/:id/approve", approveOvertime);
router.patch("/:id/reject", rejectOvertime);
export default router;
