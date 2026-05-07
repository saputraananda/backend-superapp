import express from "express";
import {
  getComplaintMeta,
  getComplaintCustomers,
  getComplaintEmployees,
  getComplaintSummary,
  getComplaints,
  getComplaintById,
  createComplaint,
  updateComplaint,
  deleteComplaint,
  addProgressLog,
} from "../controllers/complaintController.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadComplaintDoc } from "../middleware/upload.js";

const router = express.Router();

// Meta (types, categories, topics, outlets)
router.get("/meta",      requireAuth, getComplaintMeta);

// Autocomplete helpers
router.get("/customers", requireAuth, getComplaintCustomers);
router.get("/employees", requireAuth, getComplaintEmployees);

// Dashboard summary
router.get("/summary", requireAuth, getComplaintSummary);

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
