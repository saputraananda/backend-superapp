// src/routes/csatNpsRoutes.js
import express from "express";
import { getStats, getResponses, createResponse, deleteResponse } from "../controllers/csatNpsController.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// Dashboard stats (auth required)
router.get("/stats/:brand", requireAuth, getStats);

// List responses (auth required)
router.get("/:brand", requireAuth, getResponses);

// Create survey response (public — no auth)
router.post("/:brand", createResponse);

// Delete response (auth required)
router.delete("/:brand/:id", requireAuth, deleteResponse);

export default router;
