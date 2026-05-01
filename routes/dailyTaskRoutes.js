import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadDailyEvidence } from "../middleware/upload.js";
import {
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  getDepartments,
  getCompanies,
  getEmployees,
} from "../controllers/dailyTaskController.js";

const router = express.Router();

// GET — tidak perlu multer
router.get("/",            requireAuth, getTasks);
router.get("/departments", requireAuth, getDepartments);
router.get("/companies",   requireAuth, getCompanies);
router.get("/employees",   requireAuth, getEmployees);

// POST & PUT: multer HARUS dipasang sebelum controller
router.post(
  "/",
  requireAuth,
  uploadDailyEvidence.array("evidences", 10),
  createTask
);
router.put(
  "/:id",
  requireAuth,
  uploadDailyEvidence.array("evidences", 10),
  updateTask
);

router.delete("/:id", requireAuth, deleteTask);

export default router;