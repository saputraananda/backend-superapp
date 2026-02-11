import express from "express";
import { getEmployees, createEmployee } from "../controllers/employeeController.js";
const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: "Unauthorized" });
  next();
}

router.get("/", requireAuth, getEmployees);
router.post("/", requireAuth, createEmployee);

export default router;