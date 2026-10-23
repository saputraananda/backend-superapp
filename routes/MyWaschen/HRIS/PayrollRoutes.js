import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getPayrollList,
  getPayrollDetailsAll,
  getPayrollDetail,
} from "../../../controllers/MyWaschen/HRIS/PayrollController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getPayrollList);
router.get("/details", getPayrollDetailsAll);
router.get("/:employeeId", getPayrollDetail);
export default router;
