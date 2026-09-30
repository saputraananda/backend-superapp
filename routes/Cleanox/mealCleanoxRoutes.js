import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
	listMeals,
	getMealRekap,
	getMealById,
	createMeal,
	updateMeal,
	deleteMeal,
	completeMeal,
	serveMealProof,
} from "../../controllers/Cleanox/mealCleanoxController.js";
import {
	getMealRates,
	updateMealRate,
	getPlotContext,
	listMealRequests,
	createMealRequest,
	getMealRequestById,
	deleteMealRequest,
	completeMealTransfer,
} from "../../controllers/Cleanox/mealRapelCleanoxController.js";
import { uploadCleanoxMeal } from "../../middleware/upload.js";

const router = express.Router();

function handleProofUpload(req, res, next) {
	uploadCleanoxMeal.single("proof_doc")(req, res, (err) => {
		if (err) {
			return res.status(400).json({
				message: err.message || "Upload bukti gagal",
			});
		}
		next();
	});
}

router.get("/rekap", requireAuth, getMealRekap);
router.get("/proofs/:filename", requireAuth, serveMealProof);
router.get("/rates", requireAuth, getMealRates);
router.put("/rates/:code", requireAuth, updateMealRate);
router.get("/plot-context", requireAuth, getPlotContext);
router.get("/requests", requireAuth, listMealRequests);
router.post("/requests", requireAuth, createMealRequest);
router.get("/requests/:id", requireAuth, getMealRequestById);
router.delete("/requests/:id", requireAuth, deleteMealRequest);
router.put("/transfers/:id/complete", requireAuth, handleProofUpload, completeMealTransfer);
router.get("/", requireAuth, listMeals);
router.post("/", requireAuth, createMeal);
router.get("/:id", requireAuth, getMealById);
router.put("/:id/complete", requireAuth, handleProofUpload, completeMeal);
router.put("/:id", requireAuth, updateMeal);
router.delete("/:id", requireAuth, deleteMeal);

export default router;
