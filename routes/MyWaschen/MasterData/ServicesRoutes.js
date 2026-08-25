import express from "express";
import {
  getServices,
  getServiceById,
  getNextServiceCode,
  createService,
  updateService,
  deleteService,
} from "../../../controllers/MyWaschen/MasterData/ServicesController.js";

const router = express.Router();

router.get("/", getServices);
router.get("/next-code", getNextServiceCode);
router.get("/:id", getServiceById);
router.post("/", createService);
router.put("/:id", updateService);
router.delete("/:id", deleteService);

export default router;
