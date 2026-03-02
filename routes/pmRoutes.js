// src/routes/pmRoutes.js
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import {
  listProjects, createProject, getProjectDetail, updateProject, deleteProject,
  listSemesters, createSemester, getSemesterDetail, updateSemester, deleteSemester,
  listMonthlyBySemester, createMonthly, getMonthlyDetail, updateMonthly, deleteMonthly,
  getMonthlyTasksWithAssignees, createTask, updateTask, deleteTask,
  listComments, addComment,
  uploadEvidence, deleteEvidence,
  listEmployees,
  listNotifications, markNotifRead, markAllNotifRead,
} from "../controllers/pmController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, "..", "assets", "evidence");
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ── Projects ──────────────────────────────────────────
router.get("/projects",                           listProjects);
router.post("/projects",                          createProject);
router.get("/projects/:projectId",                getProjectDetail);
router.put("/projects/:projectId",                updateProject);
router.delete("/projects/:projectId",             deleteProject);

// ── Semesters ─────────────────────────────────────────
router.get("/projects/:projectId/semesters",      listSemesters);
router.post("/projects/:projectId/semesters",     createSemester);
router.get("/semesters/:semesterId",              getSemesterDetail);
router.put("/semesters/:semesterId",              updateSemester);
router.delete("/semesters/:semesterId",           deleteSemester);

// ── Monthly ───────────────────────────────────────────
router.get("/semesters/:semesterId/monthlies",    listMonthlyBySemester);
router.post("/semesters/:semesterId/monthlies",   createMonthly);
router.get("/monthlies/:monthlyId",               getMonthlyDetail);
router.put("/monthlies/:monthlyId",               updateMonthly);
router.delete("/monthlies/:monthlyId",            deleteMonthly);

// ── Tasks ─────────────────────────────────────────────
router.get("/monthlies/:monthlyId/tasks",         getMonthlyTasksWithAssignees);
router.post("/monthlies/:monthlyId/tasks",        createTask);
router.put("/tasks/:taskId",                      updateTask);
router.delete("/tasks/:taskId",                   deleteTask);

// ── Comments ──────────────────────────────────────────
router.get("/tasks/:taskId/comments",             listComments);
router.post("/tasks/:taskId/comments",            addComment);

// ── Evidence ──────────────────────────────────────────
router.post("/tasks/:taskId/evidence",            upload.array("files", 10), uploadEvidence);
router.delete("/evidence/:evidenceId",            deleteEvidence);

// ── Employees ─────────────────────────────────────────
router.get("/employees",                          listEmployees);

// ── Notifications ─────────────────────────────────────
router.get("/notifications",                      listNotifications);
router.patch("/notifications/:notifId/read",      markNotifRead);
router.patch("/notifications/read-all",           markAllNotifRead);

export default router;