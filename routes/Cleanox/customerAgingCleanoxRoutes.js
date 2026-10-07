import express from "express";
import {
  getCustomerAgingCategories,
  getCustomerAgingStats,
  listCustomerAging,
} from "../../controllers/Cleanox/customerAgingCleanoxController.js";

const router = express.Router();

router.get("/categories", getCustomerAgingCategories);
router.get("/stats", getCustomerAgingStats);
router.get("/", listCustomerAging);

export default router;
