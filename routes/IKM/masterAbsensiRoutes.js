import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getShiftsNormal,
	createShiftNormal,
	updateShiftNormal,
	deleteShiftNormal,
	getShiftsValet,
	createShiftValet,
	updateShiftValet,
	deleteShiftValet,
} from "../../controllers/IKM/masterAbsensiController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Master Absensi API" });
});

// ─── Shift Normal ──────────────────────────────────────────────────────────
router.get("/shifts-normal", requireAuth, getShiftsNormal);
router.post("/shifts-normal", requireAuth, createShiftNormal);
router.put("/shifts-normal/:id", requireAuth, updateShiftNormal);
router.delete("/shifts-normal/:id", requireAuth, deleteShiftNormal);

// ─── Shift Valet ───────────────────────────────────────────────────────────
router.get("/shifts-valet", requireAuth, getShiftsValet);
router.post("/shifts-valet", requireAuth, createShiftValet);
router.put("/shifts-valet/:id", requireAuth, updateShiftValet);
router.delete("/shifts-valet/:id", requireAuth, deleteShiftValet);

export default router;
