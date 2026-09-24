import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getApps, getAppAuthorization, getSalesStats, getCustomerTargets, getEmployeeStats } from "../controllers/appController.js";

const router = express.Router();

router.get("/", requireAuth, getApps);
router.get("/authorization", requireAuth, getAppAuthorization);
router.get("/smartlink/sales-stats", requireAuth, getSalesStats); 
router.get("/smartlink/customer-targets", requireAuth, getCustomerTargets); 
router.get("/employee-stats", requireAuth, getEmployeeStats);

export default router;