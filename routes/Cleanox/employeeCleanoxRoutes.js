import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  listCleanoxEmployees,
  getAssignableEmployees,
  addCleanoxEmployee,
  updateEmployeeRole,
} from "../../controllers/Cleanox/employeeCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, listCleanoxEmployees);
router.get("/assignable", requireAuth, getAssignableEmployees);
router.post("/", requireAuth, addCleanoxEmployee);
router.put("/:id/role", requireAuth, updateEmployeeRole);

export default router;
