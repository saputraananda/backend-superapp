import express from "express";
import {
  getPaymentMethods,
  getPaymentMethodById,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  getPaymentSettings,
  updatePaymentSettings,
} from "../../../controllers/MyWaschen/MasterData/PaymentMethodController.js";

const router = express.Router();

// Harus sebelum /:id
router.get("/settings", getPaymentSettings);
router.put("/settings", updatePaymentSettings);

router.get("/", getPaymentMethods);
router.get("/:id", getPaymentMethodById);
router.post("/", createPaymentMethod);
router.put("/:id", updatePaymentMethod);
router.delete("/:id", deletePaymentMethod);

export default router;
