import express from "express";
import { getReligions, getReligionById, createReligion, updateReligion, deleteReligion } from "../../controllers/masterDataSuperApp/masterReligionController.js";

const router = express.Router();
router.get("/",       getReligions);
router.get("/:id",    getReligionById);
router.post("/",      createReligion);
router.put("/:id",    updateReligion);
router.delete("/:id", deleteReligion);
export default router;
