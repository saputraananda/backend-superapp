import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getDailyReportList,
  getDailyReportById,
  updateDailyReportShift,
  getCashDepositList,
} from "../../../controllers/MyWaschen/Transaction/DailyReportController.js";

const router = express.Router();

router.get("/", requireAuth, getDailyReportList);
router.get("/cash-deposits", requireAuth, getCashDepositList);
router.get("/:id", requireAuth, getDailyReportById);
router.put("/:id", requireAuth, updateDailyReportShift);

export default router;
