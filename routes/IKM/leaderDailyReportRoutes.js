import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getDailyReports,
  getDailyReportMeta,
  getEmployeeOptions,
  createDailyReport,
  updateDailyReport,
  deleteDailyReport,
} from "../../controllers/IKM/leaderDailyReportController.js";
import { uploadIKMBriefing } from "../../middleware/upload.js";

const router = express.Router();

router.get("/meta",           requireAuth, getDailyReportMeta);
router.get("/employee-options", requireAuth, getEmployeeOptions);
router.get("/",               requireAuth, getDailyReports);
router.post("/",              requireAuth, uploadIKMBriefing.single("briefing_doc"), createDailyReport);
router.put("/:id",            requireAuth, uploadIKMBriefing.single("briefing_doc"), updateDailyReport);
router.delete("/:id",         requireAuth, deleteDailyReport);

export default router;
