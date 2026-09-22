import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getAttendanceList,
  createAttendance,
  updateAttendance,
  deleteAttendance,
  getAttendanceDetail,
  getCleanlinessList,
} from "../../../controllers/MyWaschen/HRIS/AttendanceController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/cleanliness", getCleanlinessList);
router.get("/:id/detail", getAttendanceDetail);
router.get("/", getAttendanceList);
router.post("/", createAttendance);
router.put("/:id", updateAttendance);
router.delete("/:id", deleteAttendance);
export default router;
