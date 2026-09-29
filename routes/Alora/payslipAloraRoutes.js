import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { uploadAloraPayslip } from "../../middleware/upload.js";
import {
	deleteEmployeePayslip,
	listEmployeePayslips,
	listPayslipEmployees,
	updateEmployeePayslip,
	uploadEmployeePayslip,
	viewEmployeePayslip,
} from "../../controllers/Alora/payslipAloraController.js";

const router = express.Router();

const handlePayslipUpload = (req, res, next) =>
	uploadAloraPayslip.single("file")(req, res, (err) =>
		err ? res.status(400).json({ message: err.message }) : next()
	);

router.get("/", requireAuth, listPayslipEmployees);
router.get("/:employeeId", requireAuth, listEmployeePayslips);
router.post("/:employeeId", requireAuth, handlePayslipUpload, uploadEmployeePayslip);
router.get("/:employeeId/:payslipId/view", requireAuth, viewEmployeePayslip);
router.put("/:employeeId/:payslipId", requireAuth, handlePayslipUpload, updateEmployeePayslip);
router.delete("/:employeeId/:payslipId", requireAuth, deleteEmployeePayslip);

export default router;
