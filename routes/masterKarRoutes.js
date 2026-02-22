import express from "express";
import {
  getDashboardSummary,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  resignEmployee,
} from "../controllers/masterKarController.js";

const router = express.Router();

router.get("/dashboard",           getDashboardSummary);
router.get("/employees",           listEmployees);
router.get("/employees/:id",       getEmployee);
router.put("/employees/:id",       updateEmployee);
router.delete("/employees/:id",    deleteEmployee);
router.post("/employees/:id/resign", resignEmployee);

export default router;