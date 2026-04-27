import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getLinenReports,
  getLinenReportMeta,
  createLinenReport,
  updateLinenReport,
  deleteLinenReport,
} from "../../controllers/IKM/linenReportController.js";
import { uploadIKMLinen } from "../../middleware/upload.js";

const router = express.Router();

router.get("/meta",  requireAuth, getLinenReportMeta);
router.get("/",      requireAuth, getLinenReports);
router.post("/",     requireAuth, uploadIKMLinen.single("attachment"), createLinenReport);
router.put("/:id",   requireAuth, uploadIKMLinen.single("attachment"), updateLinenReport);
router.delete("/:id",requireAuth, deleteLinenReport);

export default router;
