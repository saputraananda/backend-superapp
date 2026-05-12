import express from "express";
import { getBanks, getBankById, createBank, updateBank, deleteBank } from "../../controllers/masterDataSuperApp/masterBankController.js";

const router = express.Router();
router.get("/",       getBanks);
router.get("/:id",    getBankById);
router.post("/",      createBank);
router.put("/:id",    updateBank);
router.delete("/:id", deleteBank);
export default router;
