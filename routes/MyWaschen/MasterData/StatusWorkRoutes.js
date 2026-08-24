import express from "express";
import {
  getStatusWorks,
  getStatusWorkById,
  createStatusWork,
  updateStatusWork,
  deleteStatusWork,
} from "../../../controllers/MyWaschen/MasterData/StatusWorkController.js";

const router = express.Router();

router.get("/", getStatusWorks);
router.get("/:id", getStatusWorkById);
router.post("/", createStatusWork);
router.put("/:id", updateStatusWork);
router.delete("/:id", deleteStatusWork);

export default router;
