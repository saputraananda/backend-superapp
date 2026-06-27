import express from "express";
import {
  getServices,
  createService,
  updateService,
  deleteService,
  getCategories,
  getSatuans,
} from "../../controllers/Cleanox/masterServicesController.js";

const router = express.Router();

router.get("/", getServices);
router.post("/", createService);
router.put("/:id", updateService);
router.delete("/:id", deleteService);
router.get("/categories", getCategories);
router.get("/satuan", getSatuans);

export default router;
