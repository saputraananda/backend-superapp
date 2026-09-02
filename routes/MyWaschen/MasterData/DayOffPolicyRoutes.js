import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getDayOffPolicies,
  createDayOffPolicy,
  updateDayOffPolicy,
  deleteDayOffPolicy,
} from "../../../controllers/MyWaschen/MasterData/DayOffPolicyController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getDayOffPolicies);
router.post("/", createDayOffPolicy);
router.put("/:id", updateDayOffPolicy);
router.delete("/:id", deleteDayOffPolicy);
export default router;
