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
import { uploadCleanoxMeal } from "../../middleware/upload.js";

const router = express.Router();

router.get("/rekap", requireAuth, getMealRekap);
router.get("/proofs/:filename", requireAuth, serveMealProof);
router.get("/", requireAuth, listMeals);
router.post("/", requireAuth, createMeal);
router.get("/:id", requireAuth, getMealById);
router.put(
	"/:id/complete",
	requireAuth,
	(req, res, next) => {
		uploadCleanoxMeal.single("proof_doc")(req, res, (err) => {
			if (err) {
				return res.status(400).json({
					message: err.message || "Upload bukti gagal",
				});
			}
			next();
		});
	},
	completeMeal
);
router.put("/:id", requireAuth, updateMeal);
router.delete("/:id", requireAuth, deleteMeal);

export default router;
