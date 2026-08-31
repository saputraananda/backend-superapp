import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getPettyCashSummary,
  getPettyCashList,
  getPettyCashById,
  updatePettyCash,
  approvePettyCash,
  rejectPettyCash,
  deletePettyCash,
} from "../../../controllers/MyWaschen/Transaction/PettyCashController.js";

const router = express.Router();

router.get("/summary", requireAuth, getPettyCashSummary);
router.get("/", requireAuth, getPettyCashList);
router.get("/:id", requireAuth, getPettyCashById);
router.put("/:id", requireAuth, updatePettyCash);
router.patch("/:id/approve", requireAuth, approvePettyCash);
router.patch("/:id/reject", requireAuth, rejectPettyCash);
router.delete("/:id", requireAuth, deletePettyCash);

export default router;
