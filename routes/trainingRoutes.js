import express from "express";
import {
  getRequests,
  getRequestById,
  createRequest,
  updateRequest,
  deleteRequest,
  approveSupervisor,
  rejectSupervisor,
  approveHRD,
  rejectHRD,
  scheduleHRD,
  completeHRD,
  trainingEvents
} from "../controllers/trainingController.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadTrainingEvidence } from "../middleware/upload.js";

const router = express.Router();

// Realtime events (SSE connection)
router.get("/events", trainingEvents);

// Main CRUD endpoints
router.get("/", requireAuth, getRequests);
router.get("/:id", requireAuth, getRequestById);
router.post("/", requireAuth, createRequest);
router.put("/:id", requireAuth, updateRequest);
router.delete("/:id", requireAuth, deleteRequest);

// Supervisor approval flow
router.post("/:id/supervisor-approve", requireAuth, approveSupervisor);
router.post("/:id/supervisor-reject", requireAuth, rejectSupervisor);

// HRD approval flow
router.post("/:id/hrd-approve", requireAuth, approveHRD);
router.post("/:id/hrd-reject", requireAuth, rejectHRD);
router.post("/:id/hrd-schedule", requireAuth, scheduleHRD);
router.post("/:id/hrd-complete", requireAuth, uploadTrainingEvidence.array("evidence", 10), completeHRD);

export default router;
