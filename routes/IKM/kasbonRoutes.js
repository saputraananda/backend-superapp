import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getKasbons,
  getKasbonDetail,
  getEmployeeOptions,
  getEmployeeSummary,
  createKasbon,
  updateKasbon,
  updateKasbonStatus,
  deleteKasbon,
  addPayment,
  deletePayment,
} from "../../controllers/IKM/kasbonController.js";
import { uploadIKMKasbon } from "../../middleware/upload.js";

const router = express.Router();

router.get("/employee-options",  requireAuth, getEmployeeOptions);
router.get("/employee-summary",  requireAuth, getEmployeeSummary);
router.get("/",                  requireAuth, getKasbons);
router.get("/:id", requireAuth, getKasbonDetail);
router.post("/", requireAuth, uploadIKMKasbon.single("proof_file"), createKasbon);
router.put("/:id", requireAuth, uploadIKMKasbon.single("proof_file"), updateKasbon);
router.put("/:id/status", requireAuth, updateKasbonStatus);
router.delete("/:id", requireAuth, deleteKasbon);
router.post("/:id/payment", requireAuth, addPayment);
router.delete("/:id/payment/:paymentId", requireAuth, deletePayment);

export default router;
