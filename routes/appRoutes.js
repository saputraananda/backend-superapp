import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getApps, getSalesStats } from "../controllers/appController.js";

const router = express.Router();

router.get("/", requireAuth, getApps);
router.get("/smartlink/sales-stats", requireAuth, getSalesStats); // ← NEW

export default router;