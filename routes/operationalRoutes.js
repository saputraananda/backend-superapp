import express from "express";
import {
	getChemicalLeaderMeta,
	getChemicalLeaderReports,
	createChemicalLeaderReport,
	updateChemicalLeaderReport,
	deleteChemicalLeaderReport,
	getCompanies,
	getOutlets,
} from "../controllers/operationalController.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadBuktiLO } from "../middleware/upload.js";

const router = express.Router();

router.get("/companies", requireAuth, getCompanies);
router.get("/outlets", requireAuth, getOutlets);
router.get("/chemical-leader/meta", requireAuth, getChemicalLeaderMeta);
router.get("/chemical-leader/reports", requireAuth, getChemicalLeaderReports);
router.post(
	"/chemical-leader/reports",
	requireAuth,
	uploadBuktiLO.array("photos", 10),
	createChemicalLeaderReport
);
router.put(
	"/chemical-leader/reports/:id",
	requireAuth,
	uploadBuktiLO.array("photos", 10),
	updateChemicalLeaderReport
);
router.delete(
	"/chemical-leader/reports/:id",
	requireAuth,
	deleteChemicalLeaderReport
);

export default router;
