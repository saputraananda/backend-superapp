import express from "express";
import {
  getCustomerAgingCategories,
  getCustomerAgingStats,
  listCustomerAging,
  recordCustomerReminder,
  cancelCustomerReminder,
} from "../../controllers/Cleanox/customerAgingCleanoxController.js";

const router = express.Router();

router.get("/categories", getCustomerAgingCategories);
router.get("/stats", getCustomerAgingStats);
router.get("/", listCustomerAging);
router.post("/remind", recordCustomerReminder);
router.post("/unremind", cancelCustomerReminder);

export default router;
