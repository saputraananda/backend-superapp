import express from "express";
import { getInventoryDashboard } from "../../../controllers/MyWaschen/Inventory/DashboardInventoryController.js";

const router = express.Router();

router.get("/", getInventoryDashboard);

export default router;
