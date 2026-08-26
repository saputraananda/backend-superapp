import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getBugarReport } from "../../controllers/Alora/bugarAloraController.js";

const router = express.Router();

router.get("/", requireAuth, getBugarReport);

export default router;
