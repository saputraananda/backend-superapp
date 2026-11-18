import express from "express";
import {
  getSalesTargetsForMonth,
  getOutletSalesTargetHistory,
  saveSalesTarget,
  deleteSalesTarget,
  getCustomerTargets,
  saveCustomerTarget,
  deleteCustomerTarget,
} from "../../../controllers/MyWaschen/MasterData/TargetController.js";

// Target Waschen — dikelola dari My Waschen > Master Outlet
const router = express.Router();

router.get("/sales", getSalesTargetsForMonth);
router.get("/sales/outlet/:outletId", getOutletSalesTargetHistory);
router.post("/sales", saveSalesTarget);
router.delete("/sales/:id", deleteSalesTarget);

router.get("/customer", getCustomerTargets);
router.post("/customer", saveCustomerTarget);
router.delete("/customer/:id", deleteCustomerTarget);

export default router;
