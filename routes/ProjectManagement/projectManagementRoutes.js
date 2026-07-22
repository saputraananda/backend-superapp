// routes/ProjectManagement/projectManagementRoutes.js
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import multer from "multer";

import {
  // Workspace
  listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  // Sub-Workspace
  listSubWorkspaces, createSubWorkspace, updateSubWorkspace, deleteSubWorkspace,
  // Tasks
  listTasks, createTask, updateTask, updateTaskStatus, deleteTask,
  getTaskDetail, uploadTaskEvidence, listTaskEvidences, deleteTaskEvidence,
  listMyTasks, listWorkspaceTasks,
  // Discussion / Comments
  listTaskComments, createTaskComment,
  // Helpers
  listEmployees, listDepartments, getMe, listCompanies,
} from "../../controllers/ProjectManagement/projectManagementController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Upload storage untuk pm_evidence ─────────────────────────────────────────
const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? (process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/")
  : path.join(__dirname, "..", "..", "assets");

const PM_EVIDENCE_DIR = path.join(BASE_DIR, "pm_evidence");
if (!fs.existsSync(PM_EVIDENCE_DIR)) fs.mkdirSync(PM_EVIDENCE_DIR, { recursive: true });

const pmEvidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PM_EVIDENCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 60);
    cb(null, `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});

const uploadPmEvidence = multer({
  storage: pmEvidenceStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = express.Router();

// ── Workspaces ────────────────────────────────────────────────────────────────
router.get("/workspaces",          listWorkspaces);
router.post("/workspaces",         createWorkspace);
router.put("/workspaces/:id",      updateWorkspace);
router.delete("/workspaces/:id",   deleteWorkspace);
router.get("/workspaces/:id/tasks",listWorkspaceTasks);
router.post("/workspaces/:id/tasks",createTask);

// ── Sub-Workspaces ────────────────────────────────────────────────────────────
router.get("/workspaces/:id/sub",    listSubWorkspaces);
router.post("/workspaces/:id/sub",   createSubWorkspace);
router.put("/sub-workspaces/:id",    updateSubWorkspace);
router.delete("/sub-workspaces/:id", deleteSubWorkspace);

// ── Tasks ─────────────────────────────────────────────────────────────────────
router.get("/tasks/assigned",             listMyTasks);
router.get("/sub-workspaces/:id/tasks",   listTasks);
router.post("/sub-workspaces/:id/tasks",  createTask);
router.get("/tasks/:id",                  getTaskDetail);
router.put("/tasks/:id",                  updateTask);
router.patch("/tasks/:id/status",         updateTaskStatus);
router.delete("/tasks/:id",               deleteTask);

// ── Task Comments / Discussion ────────────────────────────────────────────────
router.get("/tasks/:id/comments",         listTaskComments);
router.post("/tasks/:id/comments",        createTaskComment);

// ── Task Evidence Upload & Management ─────────────────────────────────────────
router.get("/tasks/:id/evidence",                  listTaskEvidences);
router.post("/tasks/:id/evidence", uploadPmEvidence.single("file"), uploadTaskEvidence);
router.delete("/tasks/:id/evidence/:evidenceId",   deleteTaskEvidence);

// ── Helpers ───────────────────────────────────────────────────────────────────
router.get("/employees",   listEmployees);
router.get("/departments", listDepartments);
router.get("/companies",   listCompanies);
router.get("/me",          getMe);

export default router;
