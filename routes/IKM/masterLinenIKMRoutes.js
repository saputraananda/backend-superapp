// src/routes/IKM/masterLinenIKMRoutes.js
import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getLinenList,
  getLinenById,
  getLinenDropdown,
  getCategories,
  getSizes,
  getColors,
  getMaterials,
  createLinen,
  updateLinen,
  deleteLinen,
  getPriceHistory,
  addPriceHistory,
  deletePriceHistory,
} from "../../controllers/IKM/masterLinenIKMController.js";

const router = express.Router();

// ── Master data lookups ──
router.get("/categories",       requireAuth, getCategories);
router.get("/sizes",            requireAuth, getSizes);
router.get("/colors",           requireAuth, getColors);
router.get("/materials",        requireAuth, getMaterials);

// ── Linen CRUD ──
router.get("/",                 requireAuth, getLinenList);
router.get("/dropdown",         requireAuth, getLinenDropdown);
router.get("/:id",              requireAuth, getLinenById);
router.post("/",                requireAuth, createLinen);
router.put("/:id",              requireAuth, updateLinen);
router.delete("/:id",           requireAuth, deleteLinen);

// ── Price history ──
router.get("/:id/price-history",      requireAuth, getPriceHistory);
router.post("/:id/price-history",     requireAuth, addPriceHistory);
router.delete("/price-history/:priceId", requireAuth, deletePriceHistory);

export default router;
