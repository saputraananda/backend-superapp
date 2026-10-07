import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getAttendanceList,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  getAttendanceDetail,
  getCleanlinessList,
  deleteCleanlinessPhoto,
} from "../../../controllers/MyWaschen/HRIS/AttendanceController.js";
import { getGroomingDashboard } from "../../../controllers/MyWaschen/HRIS/DashboardGroomingController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/grooming-dashboard", getGroomingDashboard);
router.get("/cleanliness", getCleanlinessList);
router.delete("/cleanliness/:photoId", deleteCleanlinessPhoto);
router.get("/:id/detail", getAttendanceDetail);
router.get("/", getAttendanceList);
router.post("/", createAttendance);
router.put("/:id", updateAttendance);
router.delete("/:id", deleteAttendance);
export default router;
