import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getPendapatanCleanox } from "../../controllers/Cleanox/pendapatanCleanoxController.js";

const router = express.Router();

router.get("/", requireAuth, getPendapatanCleanox);

export default router;
