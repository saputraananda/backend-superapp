import express from "express";
import {
  getTargets,
  createTarget,
  updateTarget,
  deleteTarget,
} from "../../controllers/Cleanox/targetCleanoxController.js";

const router = express.Router();

router.get("/", getTargets);
router.post("/", createTarget);
router.put("/:id", updateTarget);
router.delete("/:id", deleteTarget);

export default router;
