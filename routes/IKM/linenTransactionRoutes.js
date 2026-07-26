import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getLinenTransactions,
  getLinenTransactionById,
  getHospitals,
  getHospitalRooms,
  getEmployees,
  getHospitalLinens,
  createLinenTransaction,
  updateLinenTransaction,
  deleteLinenTransaction,
  proxySignature,
  getRekapCuciLinen,
} from "../../controllers/IKM/linenTransactionController.js";

const router = express.Router();

// Allow public image loading for signature-proxy (used by <img> tags)
router.get("/signature-proxy", proxySignature);

// Apply auth check globally on remaining routes
router.use(requireAuth);

router.get("/", getLinenTransactions);
router.get("/rekap/cuci", getRekapCuciLinen);
router.get("/hospitals", getHospitals);
router.get("/hospitals/:hospitalId/rooms", getHospitalRooms);
router.get("/hospitals/:hospitalId/linens", getHospitalLinens);
router.get("/employees", getEmployees);
router.get("/:id", getLinenTransactionById);
router.post("/", createLinenTransaction);
router.put("/:id", updateLinenTransaction);
router.delete("/:id", deleteLinenTransaction);

export default router;
