import express from "express";
import {
  getServices,
  getServiceById,
  createService,
  updateService,
  deleteService,
  getOutletServices,
  upsertOutletService,
  setOutletServiceAvailability,
} from "../../../controllers/MyWaschen/MasterData/ServicesController.js";

const router = express.Router();

router.get("/", getServices);
// Layanan per outlet — harus sebelum "/:id"
router.get("/outlets/:outletId", getOutletServices);
router.post("/outlets/:outletId/availability", setOutletServiceAvailability);
router.put("/:id/outlets/:outletId", upsertOutletService);
router.get("/:id", getServiceById);
router.post("/", createService);
router.put("/:id", updateService);
router.delete("/:id", deleteService);

export default router;
