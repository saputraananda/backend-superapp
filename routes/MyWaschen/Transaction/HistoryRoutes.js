import express from "express";
import {
  getTransactions,
  getTransactionById,
  getTransactionSummary,
  updateTransactionPayment,
  requestDeleteTransaction,
  approveDeleteTransaction,
  approveRefundTransaction,
  updateItemWorkStatus,
} from "../../../controllers/MyWaschen/Transaction/HistoryController.js";

const router = express.Router();

router.get("/summary", getTransactionSummary);
router.get("/", getTransactions);
router.get("/:id", getTransactionById);
router.patch("/:id/payment", updateTransactionPayment);
router.patch("/:id/request-delete", requestDeleteTransaction);
router.patch("/:id/approve-delete", approveDeleteTransaction);
router.patch("/:id/approve-refund", approveRefundTransaction);
router.patch("/:id/items/:itemId/status", updateItemWorkStatus);

export default router;
