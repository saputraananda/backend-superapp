import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  listWaschenEmployees,
  getAssignableEmployees,
  addWaschenEmployee,
  updateEmployeeRole,
} from "../../../controllers/MyWaschen/General/employeeWaschenController.js";

const router = express.Router();

router.get("/", requireAuth, listWaschenEmployees);
router.get("/assignable", requireAuth, getAssignableEmployees);
router.post("/", requireAuth, addWaschenEmployee);
router.put("/:id/role", requireAuth, updateEmployeeRole);

export default router;
