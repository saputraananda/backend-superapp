import express from "express";
import {
  getPettyCashCategories,
  getPettyCashCategoryById,
  createPettyCashCategory,
  updatePettyCashCategory,
  deletePettyCashCategory,
} from "../../../controllers/MyWaschen/MasterData/PettyCashCategoryController.js";

const router = express.Router();

router.get("/", getPettyCashCategories);
router.get("/:id", getPettyCashCategoryById);
router.post("/", createPettyCashCategory);
router.put("/:id", updatePettyCashCategory);
router.delete("/:id", deletePettyCashCategory);

export default router;
