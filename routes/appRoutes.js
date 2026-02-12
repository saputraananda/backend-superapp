import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { getApps } from "../controllers/appController.js"; // ← Import controller

const router = express.Router();

// Ganti handler langsung dengan controller
router.get("/", requireAuth, getApps); // ← Pakai controller yang sudah ada filter role

export default router;