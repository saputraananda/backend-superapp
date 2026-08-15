import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  listAttendanceEmployees,
  getAttendanceEmployee,
  listAttendanceRecords,
  listEmployeeAttendanceRecords,
  serveAttendancePhoto,
  createAttendanceRecord,
  updateAttendanceRecord,
  deleteAttendanceRecord,
  upsertAttendancePhotoReviews,
} from "../../controllers/Cleanox/absensiKaryawanCleanoxController.js";

const router = express.Router();

router.get("/employees", requireAuth, listAttendanceEmployees);
router.get("/employees/:employeeId", requireAuth, getAttendanceEmployee);
router.get("/employees/:employeeId/records", requireAuth, listEmployeeAttendanceRecords);
router.get("/records", requireAuth, listAttendanceRecords);
router.post("/records", requireAuth, createAttendanceRecord);
router.get("/photos/:filename", requireAuth, serveAttendancePhoto);
router.put("/records/:attendanceId/reviews", requireAuth, upsertAttendancePhotoReviews);
router.put("/records/:attendanceId", requireAuth, updateAttendanceRecord);
router.delete("/records/:attendanceId", requireAuth, deleteAttendanceRecord);

export default router;
