import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  listKebersihanEmployees,
  getKebersihanEmployee,
  listEmployeeKebersihanRecords,
  listKebersihanRecords,
  serveKebersihanPhoto,
  upsertKebersihanAreaReviews,
} from "../../controllers/Cleanox/masterAreaKebersihanCleanoxController.js";

const router = express.Router();

router.get("/records", requireAuth, listKebersihanRecords);
router.get("/employees", requireAuth, listKebersihanEmployees);
router.get("/employees/:employeeId", requireAuth, getKebersihanEmployee);
router.get("/employees/:employeeId/records", requireAuth, listEmployeeKebersihanRecords);
router.get("/photos/:filename", requireAuth, serveKebersihanPhoto);
router.put("/reports/:reportId/reviews", requireAuth, upsertKebersihanAreaReviews);

export default router;
