import express from "express";
import {
  getPromos,
  getPromoById,
  createPromo,
  updatePromo,
  deletePromo,
} from "../../../controllers/MyWaschen/MasterData/PromoController.js";

const router = express.Router();

router.get("/", getPromos);
router.get("/:id", getPromoById);
router.post("/", createPromo);
router.put("/:id", updatePromo);
router.delete("/:id", deletePromo);

export default router;
