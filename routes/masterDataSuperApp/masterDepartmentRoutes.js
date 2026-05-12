import express from "express";
import { getDepartments, getDepartmentById, createDepartment, updateDepartment, deleteDepartment } from "../../controllers/masterDataSuperApp/masterDepartmentController.js";

const router = express.Router();
router.get("/",       getDepartments);
router.get("/:id",    getDepartmentById);
router.post("/",      createDepartment);
router.put("/:id",    updateDepartment);
router.delete("/:id", deleteDepartment);
export default router;
