import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import { getDashboard } from "../../../controllers/MyWaschen/General/DashboardController.js";

const router = express.Router();

router.get("/", requireAuth, getDashboard);

export default router;
