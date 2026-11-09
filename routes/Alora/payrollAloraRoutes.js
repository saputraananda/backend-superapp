import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getPayrollRekap } from "../../controllers/Alora/payrollAloraController.js";

const router = express.Router();

router.get("/rekap", requireAuth, getPayrollRekap);

export default router;

