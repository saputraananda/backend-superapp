import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	listEmployeeBalances,
	setAnnualLeaveBalance,
	setOvertimeBalance,
	setReplaceOffBalance,
} from "../../controllers/Alora/employeeBalancesAloraController.js";

const router = express.Router();

router.get("/", requireAuth, listEmployeeBalances);
router.put("/:employeeId/annual-leave", requireAuth, setAnnualLeaveBalance);
router.put("/:employeeId/overtime", requireAuth, setOvertimeBalance);
router.put("/:employeeId/replace-off", requireAuth, setReplaceOffBalance);

export default router;
