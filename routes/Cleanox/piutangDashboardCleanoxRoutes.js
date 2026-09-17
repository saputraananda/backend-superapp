import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getPiutangDashboardCleanox } from "../../controllers/Cleanox/piutangDashboardCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, getPiutangDashboardCleanox);

export default router;
