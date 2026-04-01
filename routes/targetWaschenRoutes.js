import express from "express";
import {
  getTargetSales,
  createTargetSales,
  updateTargetSales,
  deleteTargetSales,
  getTargetCustomer,
  createTargetCustomer,
  updateTargetCustomer,
  deleteTargetCustomer,
} from "../controllers/targetWaschenController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);

// ── Target Sales ──────────────────────────────────────────────────
router.get("/target", getTargetSales);
router.post("/target", createTargetSales);
router.put("/target/:id", updateTargetSales);
router.delete("/target/:id", deleteTargetSales);

// ── Target Customer ───────────────────────────────────────────────
router.get("/target-customer", getTargetCustomer);
router.post("/target-customer", createTargetCustomer);
router.put("/target-customer/:id", updateTargetCustomer);
router.delete("/target-customer/:id", deleteTargetCustomer);

export default router;