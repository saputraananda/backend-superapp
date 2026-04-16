import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { listIKMEmployees, registerIKMEmployee } from "../../controllers/IKM/employeeIKMController.js";

const router = express.Router();

router.get("/health", (req, res) => {
	res.json({ status: "OK", service: "IKM Employee API" });
});

router.get("/", requireAuth, listIKMEmployees);
router.post("/register", requireAuth, registerIKMEmployee);

export default router;
