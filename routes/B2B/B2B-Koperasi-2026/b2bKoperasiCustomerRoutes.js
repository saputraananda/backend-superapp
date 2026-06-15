// src/routes/B2B/B2B-Koperasi-2026/b2bKoperasiCustomerRoutes.js
import express from "express";
import {
  getKmpCustomerStats,
  getKmpCustomers,
} from "../../../controllers/B2B/B2B-Koperasi-2026/b2bKoperasiCustomerController.js";
import { requireAuth } from "../../../middleware/auth.js";

const router = express.Router();

router.get("/kmp/customers/stats", requireAuth, getKmpCustomerStats);
router.get("/kmp/customers", requireAuth, getKmpCustomers);

export default router;
