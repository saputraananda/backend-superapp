// src/routes/IKM/masterLinenIKMRoutes.js
import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getLinenList,
  getCategories,
  createLinen,
  updateLinen,
  deleteLinen,
} from "../../controllers/IKM/masterLinenIKMController.js";

const router = express.Router();

router.get("/", requireAuth, getLinenList);
router.get("/categories", requireAuth, getCategories);
router.post("/", requireAuth, createLinen);
router.put("/:id", requireAuth, updateLinen);
router.delete("/:id", requireAuth, deleteLinen);

export default router;
