import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { adjustBalance, getEmployeeBalance } from "../../controllers/Alora/annualLeaveAloraController.js";

const router = express.Router();

router.get("/balance", requireAuth, getEmployeeBalance);
router.put("/:employeeId/adjust", requireAuth, adjustBalance);

export default router;
