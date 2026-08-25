import express from "express";
import {
  getPaymentMethods,
  getPaymentMethodById,
  createPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
} from "../../../controllers/MyWaschen/MasterData/PaymentMethodController.js";

const router = express.Router();

router.get("/", getPaymentMethods);
router.get("/:id", getPaymentMethodById);
router.post("/", createPaymentMethod);
router.put("/:id", updatePaymentMethod);
router.delete("/:id", deletePaymentMethod);

export default router;
