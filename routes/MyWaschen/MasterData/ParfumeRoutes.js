import express from "express";
import {
  getParfumes,
  getParfumeById,
  createParfume,
  updateParfume,
  deleteParfume,
} from "../../../controllers/MyWaschen/MasterData/ParfumeController.js";

const router = express.Router();

router.get("/", getParfumes);
router.get("/:id", getParfumeById);
router.post("/", createParfume);
router.put("/:id", updateParfume);
router.delete("/:id", deleteParfume);

export default router;
