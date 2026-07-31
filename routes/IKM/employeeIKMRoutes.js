import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	listIKMEmployees,
	registerIKMEmployee,
	setIKMEmployeeLeaderRole,
	setIKMEmployeeFloor,
	exportIKMEmployees,
	proxyIKMDocument,
	listIKMEmployeePayslips,
	uploadIKMEmployeePayslip,
	viewIKMEmployeePayslip,
	deleteIKMEmployeePayslip,
} from "../../controllers/IKM/employeeIKMController.js";
import { uploadPayslip } from "../../middleware/upload.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Employee API" });
});

router.get("/", requireAuth, listIKMEmployees);
router.get("/export", requireAuth, exportIKMEmployees);
router.get("/document-proxy", requireAuth, proxyIKMDocument);
router.post("/register", requireAuth, registerIKMEmployee);
router.put("/:id/leader", requireAuth, setIKMEmployeeLeaderRole);
router.put("/:id/floor", requireAuth, setIKMEmployeeFloor);

// Payslip routes
router.get("/:id/payslips", requireAuth, listIKMEmployeePayslips);
router.post("/:id/payslips", requireAuth, uploadPayslip.single("file"), uploadIKMEmployeePayslip);
router.get("/:id/payslips/:payslipId/view", requireAuth, viewIKMEmployeePayslip);
router.delete("/:id/payslips/:payslipId", requireAuth, deleteIKMEmployeePayslip);

export default router;
