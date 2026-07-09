import express from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getRewashLinens,
  getRewashLinenMeta,
  createRewashLinen,
  updateRewashDetail,
  updateRewashHeader,
  deleteRewashDetail,
} from "../controllers/IKM/rewashLinenController.js";

const router = express.Router();

router.get("/meta",       requireAuth, getRewashLinenMeta);
router.get("/",           requireAuth, getRewashLinens);
router.post("/",          requireAuth, createRewashLinen);
router.put("/:id",        requireAuth, updateRewashDetail);   // update detail qty
router.put("/:id/header", requireAuth, updateRewashHeader);   // update header notes
router.delete("/:id",     requireAuth, deleteRewashDetail);

export default router;
