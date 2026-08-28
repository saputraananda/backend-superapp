import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	getOffDays,
	createOffDays,
	deleteOffDay,
} from "../../controllers/Cleanox/workerOffDaysCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, getOffDays);
router.post("/", requireAuth, createOffDays);
router.delete("/:id", requireAuth, deleteOffDay);

export default router;
