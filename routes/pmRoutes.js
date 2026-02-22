// src/routes/pmRoutes.js
import express from "express";
import { upload } from "../middleware/upload.js";
import {
  listProjects, createProject, getProjectDetail,
  createSemester, listSemesters, getSemesterDetail,
  createMonthly, listMonthlyBySemester, getMonthlyDetail,
  createTask, updateTask,
  uploadEvidence, listEvidence, deleteEvidence,
  listTaskComments, addTaskComment,
} from "../controllers/pmController.js";

const router = express.Router();

// Projects
router.get   ("/projects",                       listProjects);
router.post  ("/projects",                       createProject);
router.get   ("/projects/:projectId",            getProjectDetail);

// Semesters
router.get   ("/projects/:projectId/semesters",  listSemesters);
router.post  ("/projects/:projectId/semesters",  createSemester);
router.get   ("/semesters/:semesterId",          getSemesterDetail);

// Monthly
router.get   ("/semesters/:semesterId/monthlies", listMonthlyBySemester);
router.post  ("/semesters/:semesterId/monthlies", createMonthly);
router.get   ("/monthlies/:monthlyId",            getMonthlyDetail);

// Tasks
router.post  ("/monthlies/:monthlyId/tasks",     createTask);
router.put   ("/tasks/:taskId",                  updateTask);

// Evidence  ← NEW
router.get   ("/tasks/:taskId/evidence",         listEvidence);
router.post  ("/tasks/:taskId/evidence",         upload.array("files", 10), uploadEvidence);
router.delete("/tasks/:taskId/evidence/:evidenceId", deleteEvidence);

// Comments
router.get   ("/tasks/:taskId/comments",         listTaskComments);
router.post  ("/tasks/:taskId/comments",         addTaskComment);

export default router;