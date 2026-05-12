import express from "express";
import { getPositions, getPositionById, createPosition, updatePosition, deletePosition } from "../../controllers/masterDataSuperApp/masterPositionController.js";

const router = express.Router();
router.get("/",       getPositions);
router.get("/:id",    getPositionById);
router.post("/",      createPosition);
router.put("/:id",    updatePosition);
router.delete("/:id", deletePosition);
export default router;
