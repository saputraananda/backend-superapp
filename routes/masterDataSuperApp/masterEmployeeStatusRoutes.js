import express from "express";
import { getEmployeeStatuses, getEmployeeStatusById, createEmployeeStatus, updateEmployeeStatus, deleteEmployeeStatus } from "../../controllers/masterDataSuperApp/masterEmployeeStatusController.js";

const router = express.Router();
router.get("/",       getEmployeeStatuses);
router.get("/:id",    getEmployeeStatusById);
router.post("/",      createEmployeeStatus);
router.put("/:id",    updateEmployeeStatus);
router.delete("/:id", deleteEmployeeStatus);
export default router;
