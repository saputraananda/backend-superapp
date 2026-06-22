import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getSizesMD, createSize, updateSize, deleteSize,
  getColorsMD, createColor, updateColor, deleteColor,
  getMaterialsMD, createMaterial, updateMaterial, deleteMaterial,
  getLinenCategories, createLinenCategory, updateLinenCategory, deleteLinenCategory,
  getVendorsMD, createVendor, updateVendor, deleteVendor,
} from "../../controllers/IKM/masterDataIKMController.js";

const router = express.Router();

router.get("/sizes",       requireAuth, getSizesMD);
router.post("/sizes",      requireAuth, createSize);
router.put("/sizes/:id",   requireAuth, updateSize);
router.delete("/sizes/:id", requireAuth, deleteSize);

router.get("/colors",       requireAuth, getColorsMD);
router.post("/colors",      requireAuth, createColor);
router.put("/colors/:id",   requireAuth, updateColor);
router.delete("/colors/:id", requireAuth, deleteColor);

router.get("/materials",       requireAuth, getMaterialsMD);
router.post("/materials",      requireAuth, createMaterial);
router.put("/materials/:id",   requireAuth, updateMaterial);
router.delete("/materials/:id", requireAuth, deleteMaterial);

router.get("/categories",       requireAuth, getLinenCategories);
router.post("/categories",      requireAuth, createLinenCategory);
router.put("/categories/:id",   requireAuth, updateLinenCategory);
router.delete("/categories/:id", requireAuth, deleteLinenCategory);

router.get("/vendors",       requireAuth, getVendorsMD);
router.post("/vendors",      requireAuth, createVendor);
router.put("/vendors/:id",   requireAuth, updateVendor);
router.delete("/vendors/:id", requireAuth, deleteVendor);

export default router;
