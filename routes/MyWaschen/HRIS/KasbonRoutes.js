import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getKasbonList,
  getKasbonById,
  processKasbon,
  approveKasbon,
  rejectKasbon,
  addKasbonPayment,
} from "../../../controllers/MyWaschen/HRIS/KasbonController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getKasbonList);
router.get("/:id", getKasbonById);
router.patch("/:id/process", processKasbon);
router.patch("/:id/approve", approveKasbon);
router.patch("/:id/reject", rejectKasbon);
router.post("/:id/payments", addKasbonPayment);
export default router;
