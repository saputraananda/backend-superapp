// src/routes/B2B/b2bKoperasiRoutes.js
import express from "express";
import { getKmpStats, getKmpTransactions } from "../../../controllers/B2B/B2B-Koperasi-2026/b2bKoperasiDashboardController.js";
import { requireAuth } from "../../../middleware/auth.js";

const router = express.Router();

router.get("/kmp/stats", requireAuth, getKmpStats);
router.get("/kmp/transactions", requireAuth, getKmpTransactions);

export default router;
