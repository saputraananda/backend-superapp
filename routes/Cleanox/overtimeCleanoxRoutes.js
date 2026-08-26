import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { listOvertime, getOvertimeById } from "../../controllers/Cleanox/overtimeCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, listOvertime);
router.get("/:id", requireAuth, getOvertimeById);

export default router;
