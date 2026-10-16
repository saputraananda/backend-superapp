import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getDayOffList,
  adminAssignDayOff,
  approveDayOff,
  rejectDayOff,
  rescheduleDayOff,
  deleteDayOff,
} from "../../../controllers/MyWaschen/HRIS/DayOffController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getDayOffList);
router.post("/", adminAssignDayOff);
router.patch("/:id/approve", approveDayOff);
router.patch("/:id/reject", rejectDayOff);
router.patch("/:id/reschedule", rescheduleDayOff);
router.delete("/:id", deleteDayOff);
export default router;
