import express from "express";
import {
  getComplaintMeta,
  getComplaintNota,
  getComplaintEmployees,
  getComplaintSummary,
  getComplaints,
  getComplaintById,
  createComplaint,
  updateComplaint,
  deleteComplaint,
  addProgressLog,
  getComplaintPeriods,
  getComplaintSameDayComparison,
} from "../controllers/complaintController.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadComplaintDoc } from "../middleware/upload.js";

const router = express.Router();

// Meta (types, categories, topics, outlets)
router.get("/meta",      requireAuth, getComplaintMeta);

// Periods (distinct months from submitted_at)
router.get("/periods",   requireAuth, getComplaintPeriods);

// Autocomplete helpers
router.get("/nota",      requireAuth, getComplaintNota);
router.get("/employees", requireAuth, getComplaintEmployees);

// Dashboard summary
router.get("/summary", requireAuth, getComplaintSummary);

// Same-day comparison across months
router.get("/same-day-comparison", requireAuth, getComplaintSameDayComparison);

// CRUD complaints
router.get("/",        requireAuth, getComplaints);
router.get("/:id",     requireAuth, getComplaintById);
router.post(
  "/",
  requireAuth,
  uploadComplaintDoc.array("documents", 10),
  createComplaint
);
router.put(
  "/:id",
  requireAuth,
  uploadComplaintDoc.array("documents", 10),
  updateComplaint
);
router.delete("/:id",  requireAuth, deleteComplaint);

// Progress log
router.post(
  "/:id/progress",
  requireAuth,
  uploadComplaintDoc.array("documents", 10),
  addProgressLog
);

export default router;
