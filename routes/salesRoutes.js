import express from "express";
import { getPenjualan } from "../controllers/salesDashboard/salesController.js";
import { getMembership } from "../controllers/salesDashboard/membershipController.js";
import { getPiutang } from "../controllers/salesDashboard/piutangController.js";
import { getKomplain } from "../controllers/salesDashboard/komplainController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

router.get("/penjualan", getPenjualan);
router.get("/membership", getMembership);
router.get("/piutang", getPiutang);
router.get("/komplain", getKomplain);

export default router;