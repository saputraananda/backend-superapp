import express from "express";
import { getCompanies, getCompanyById, createCompany, updateCompany, deleteCompany } from "../../controllers/masterDataSuperApp/masterCompanyController.js";

const router = express.Router();
router.get("/",       getCompanies);
router.get("/:id",    getCompanyById);
router.post("/",      createCompany);
router.put("/:id",    updateCompany);
router.delete("/:id", deleteCompany);
export default router;
