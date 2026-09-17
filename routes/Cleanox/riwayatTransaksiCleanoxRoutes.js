import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	listRiwayatTransaksi,
	servePaymentProof,
} from "../../controllers/Cleanox/riwayatTransaksiCleanoxController.js";

const router = express.Router();

router.get("/payment-proofs/:filename", requireAuth, servePaymentProof);
router.get("/", requireAuth, listRiwayatTransaksi);

export default router;
