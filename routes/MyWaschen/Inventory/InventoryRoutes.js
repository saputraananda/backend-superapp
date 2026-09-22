import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getInventoryItems,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  getOutletStock,
  assignItemToOutlet,
  updateOutletStock,
  adjustOutletStock,
  removeOutletStock,
  seedOutletCatalog,
  getInventoryLogs,
  getAvailableItemsForOutlet,
  getInventoryPetugas,
} from "../../../controllers/MyWaschen/Inventory/InventoryController.js";
import {
  setOpeningStock,
  getDailyOpname,
  postDailyOpname,
} from "../../../controllers/MyWaschen/Inventory/StockOpnameController.js";

const router = express.Router();

router.get("/employees", requireAuth, getInventoryPetugas);
router.get("/items", getInventoryItems);
router.post("/items", createInventoryItem);
router.put("/items/:id", updateInventoryItem);
router.delete("/items/:id", deleteInventoryItem);

router.get("/items-available", getAvailableItemsForOutlet);

router.get("/stock", getOutletStock);
router.post("/stock", assignItemToOutlet);
router.post("/stock/seed-outlet", seedOutletCatalog);
router.put("/stock/:id", updateOutletStock);
router.put("/stock/:id/opening", requireAuth, setOpeningStock);
router.post("/stock/:id/adjust", adjustOutletStock);
router.delete("/stock/:id", removeOutletStock);

router.get("/opname/daily", requireAuth, getDailyOpname);
router.post("/opname/daily", requireAuth, postDailyOpname);

router.get("/logs", getInventoryLogs);

export default router;
