import express from "express";
import { getJobLevels, getJobLevelById, createJobLevel, updateJobLevel, deleteJobLevel } from "../../controllers/masterDataSuperApp/masterJobLevelController.js";

const router = express.Router();
router.get("/",       getJobLevels);
router.get("/:id",    getJobLevelById);
router.post("/",      createJobLevel);
router.put("/:id",    updateJobLevel);
router.delete("/:id", deleteJobLevel);
export default router;
