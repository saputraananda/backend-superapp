// src/routes/pmRoutes.js
import express from "express";
import { upload } from "../middleware/upload.js";
import {
  // Projects
  listProjects, createProject, getProjectDetail, updateProject, deleteProject,
  // Semesters
  listSemesters, createSemester, getSemesterDetail, updateSemester, deleteSemester,
  // Monthly
  listMonthlyBySemester, createMonthly, getMonthlyDetail, updateMonthly, deleteMonthly,
  // Tasks
  getMonthlyTasksWithAssignees, createTask, updateTask, deleteTask,
  // Comments
  listComments, addComment,
  // Evidence
  listEvidence, uploadEvidence, deleteEvidence,
  // Employees
  listEmployees,
  // Notifications
  listNotifications, markNotifRead, markAllNotifRead,
  deleteNotif, deleteAllNotif, // ← TAMBAH
  // Companies
  listCompanies
} from "../controllers/pmController.js";

const router = express.Router();

// ── Projects ──────────────────────────────────────────────────────────────
router.get("/projects",             listProjects);
router.post("/projects",            createProject);
router.get("/projects/:projectId",  getProjectDetail);
router.put("/projects/:projectId",  updateProject);
router.delete("/projects/:projectId", deleteProject);

// ── Semesters ─────────────────────────────────────────────────────────────
router.get("/projects/:projectId/semesters",  listSemesters);
router.post("/projects/:projectId/semesters", createSemester);
router.get("/semesters/:semesterId",          getSemesterDetail);
router.put("/semesters/:semesterId",          updateSemester);
router.delete("/semesters/:semesterId",       deleteSemester);

// ── Monthly ───────────────────────────────────────────────────────────────
router.get("/semesters/:semesterId/monthlies",  listMonthlyBySemester);
router.post("/semesters/:semesterId/monthlies", createMonthly);
router.get("/monthlies/:monthlyId",             getMonthlyDetail);
router.put("/monthlies/:monthlyId",             updateMonthly);
router.delete("/monthlies/:monthlyId",          deleteMonthly);

// ── Tasks ─────────────────────────────────────────────────────────────────
router.get("/monthlies/:monthlyId/tasks",  getMonthlyTasksWithAssignees);
router.post("/monthlies/:monthlyId/tasks", createTask);
router.put("/tasks/:taskId",               updateTask);
router.delete("/tasks/:taskId",            deleteTask);

// ── Comments ──────────────────────────────────────────────────────────────
router.get("/tasks/:taskId/comments",  listComments);
router.post("/tasks/:taskId/comments", addComment);

// ── Evidence ──────────────────────────────────────────────────────────────
router.get   ("/tasks/:taskId/evidence",  listEvidence);
router.post  ("/tasks/:taskId/evidence",  upload.array("files", 20), uploadEvidence);
router.delete("/evidence/:evidenceId",    deleteEvidence);

// ── Employees ─────────────────────────────────────────────────────────────
router.get("/employees", listEmployees);

// ── Notifications ─────────────────────────────────────────────────────────
router.get("/notifications",                 listNotifications);
router.patch("/notifications/:notifId/read", markNotifRead);
router.patch("/notifications/read-all",      markAllNotifRead);
router.delete("/notifications/:notifId",     deleteNotif);    // ← TAMBAH
router.delete("/notifications",              deleteAllNotif); // ← TAMBAH

// ── Companies ─────────────────────────────────────────────────────────────
router.get("/companies", listCompanies);

export default router;