import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getStockOpnameHistory,
  getStockOpnameById,
  createStockOpname,
} from "../../controllers/IKM/stockOpnameIKMController.js";

const router = express.Router();

// Apply auth check globally on these routes
router.use(requireAuth);

router.get("/", getStockOpnameHistory);
router.get("/:id", getStockOpnameById);
router.post("/", createStockOpname);

export default router;
