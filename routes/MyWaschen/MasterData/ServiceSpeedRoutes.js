import express from "express";
import {
  getServiceSpeeds,
  getServiceSpeedById,
  createServiceSpeed,
  updateServiceSpeed,
  deleteServiceSpeed,
} from "../../../controllers/MyWaschen/MasterData/ServiceSpeedController.js";

const router = express.Router();

router.get("/", getServiceSpeeds);
router.get("/:id", getServiceSpeedById);
router.post("/", createServiceSpeed);
router.put("/:id", updateServiceSpeed);
router.delete("/:id", deleteServiceSpeed);

export default router;
