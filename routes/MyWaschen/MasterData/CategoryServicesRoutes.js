import express from "express";
import {
  getCategoryServices,
  getCategoryServiceById,
  createCategoryService,
  updateCategoryService,
  deleteCategoryService,
} from "../../../controllers/MyWaschen/MasterData/CategoryServicesController.js";

const router = express.Router();

router.get("/", getCategoryServices);
router.get("/:id", getCategoryServiceById);
router.post("/", createCategoryService);
router.put("/:id", updateCategoryService);
router.delete("/:id", deleteCategoryService);

export default router;
