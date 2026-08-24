import express from "express";
import {
  getUnits,
  getUnitById,
  createUnit,
  updateUnit,
  deleteUnit
} from "../../../controllers/MyWaschen/MasterData/UnitController.js";

const router = express.Router();

router.get("/", getUnits);
router.get("/:id", getUnitById);
router.post("/", createUnit);
router.put("/:id", updateUnit);
router.delete("/:id", deleteUnit);

export default router;
