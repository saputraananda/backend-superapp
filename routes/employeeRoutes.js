import express from "express";
import { getProfile, updateProfile, getMasterData } from "../controllers/employeeController.js";

const router = express.Router();

router.get("/profile", getProfile);
router.put("/profile", updateProfile);
router.get("/master-data", getMasterData);

export default router;