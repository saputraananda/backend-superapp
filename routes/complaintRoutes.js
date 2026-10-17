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
  updateProgressLog,
  deleteProgressLog,
  reviewComplaint,
  getComplaintPeriods,
  getComplaintSameDayComparison,
} from "../controllers/complaintController.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadComplaintDoc } from "../middleware/upload.js";

function uploadDocuments(req, res, next) {
  uploadComplaintDoc.array("documents", 10)(req, res, (err) => {
    if (!err) return next();
    let message = err.message || "Gagal mengunggah lampiran.";
    if (err.code === "LIMIT_FILE_SIZE") message = "Ukuran lampiran terlalu besar (maks 5 MB per file).";
    else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") message = "Maksimal 10 lampiran.";
    return res.status(400).json({ message });
  });
}

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
  uploadDocuments,
  createComplaint
);
router.put(
  "/:id",
  requireAuth,
  uploadDocuments,
  updateComplaint
);
router.delete("/:id",  requireAuth, deleteComplaint);

// Progress log
router.post(
  "/:id/progress",
  requireAuth,
  uploadDocuments,
  addProgressLog
);
router.post("/:id/review", requireAuth, reviewComplaint);
router.put("/progress-log/:logId", requireAuth, updateProgressLog);
router.delete("/progress-log/:logId", requireAuth, deleteProgressLog);

export default router;
