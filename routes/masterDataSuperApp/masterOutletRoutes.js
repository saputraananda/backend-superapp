import express from "express";
import { getOutlets, getOutletById, createOutlet, updateOutlet, deleteOutlet } from "../../controllers/masterDataSuperApp/masterOutletController.js";

const router = express.Router();
router.get("/",       getOutlets);
router.get("/:id",    getOutletById);
router.post("/",      createOutlet);
router.put("/:id",    updateOutlet);
router.delete("/:id", deleteOutlet);
export default router;
