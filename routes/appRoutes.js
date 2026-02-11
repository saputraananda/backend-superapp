import express from "express";
import { getApps } from "../controllers/appController.js";
const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ message: "Unauthorized" });
  next();
}

router.get("/", requireAuth, getApps);

export default router;