import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { listIKMEmployees, registerIKMEmployee, setIKMEmployeeLeaderRole } from "../../controllers/IKM/employeeIKMController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Employee API" });
});

router.get("/", requireAuth, listIKMEmployees);
router.post("/register", requireAuth, registerIKMEmployee);
router.put("/:id/leader", requireAuth, setIKMEmployeeLeaderRole);

export default router;
