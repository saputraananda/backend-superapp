import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getItemKgs,
  createItemKg,
  updateItemKg,
  deleteItemKg,
} from "../../../controllers/MyWaschen/MasterData/ItemKgController.js";

const router = express.Router();
router.use(requireAuth);
router.get("/", getItemKgs);
router.post("/", createItemKg);
router.put("/:id", updateItemKg);
router.delete("/:id", deleteItemKg);
export default router;
