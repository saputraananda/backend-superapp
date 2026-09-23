import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getKasbonList,
  getKasbonMonitor,
  getKasbonMonitorDetail,
  getKasbonById,
  processKasbon,
  approveKasbon,
  rejectKasbon,
  addKasbonPayment,
  markKasbonInstallmentPaid,
  createOpeningBalance,
} from "../../../controllers/MyWaschen/HRIS/KasbonController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getKasbonList);
router.get("/monitor", getKasbonMonitor);
router.get("/monitor/:employeeId", getKasbonMonitorDetail);
router.post("/opening", createOpeningBalance);
router.get("/:id", getKasbonById);
router.patch("/:id/process", processKasbon);
router.patch("/:id/approve", approveKasbon);
router.patch("/:id/reject", rejectKasbon);
router.post("/:id/payments", addKasbonPayment);
router.patch("/:id/payments/:paymentId/paid", markKasbonInstallmentPaid);
export default router;
