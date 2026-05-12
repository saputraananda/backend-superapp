import express from "express";
import { getEducationLevels, getEducationLevelById, createEducationLevel, updateEducationLevel, deleteEducationLevel } from "../../controllers/masterDataSuperApp/masterEducationLevelController.js";

const router = express.Router();
router.get("/",       getEducationLevels);
router.get("/:id",    getEducationLevelById);
router.post("/",      createEducationLevel);
router.put("/:id",    updateEducationLevel);
router.delete("/:id", deleteEducationLevel);
export default router;
