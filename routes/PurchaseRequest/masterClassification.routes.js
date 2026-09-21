import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
    listClassifications,
    createClassificationMaster,
    updateClassificationMaster,
    deleteClassificationMaster,
} from "../../controllers/PurchaseRequest/masterClassification.controller.js";

const router = Router();

// Semua endpoint di-guard ulang sebagai Finance di dalam controller.
router.get("/",       requireAuth, listClassifications);
router.post("/",      requireAuth, createClassificationMaster);
router.put("/:id",    requireAuth, updateClassificationMaster);
router.delete("/:id", requireAuth, deleteClassificationMaster);

export default router;
