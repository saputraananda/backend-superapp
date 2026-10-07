import express from "express";
import {
  getMasterAgingServices,
  createMasterAgingService,
  updateMasterAgingService,
  deleteMasterAgingService,
} from "../../controllers/Cleanox/masterAgingServicesController.js";

const router = express.Router();

router.get("/", getMasterAgingServices);
router.post("/", createMasterAgingService);
router.put("/:id", updateMasterAgingService);
router.delete("/:id", deleteMasterAgingService);

export default router;
