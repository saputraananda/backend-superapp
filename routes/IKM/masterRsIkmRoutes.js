import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getHospitals,
  createHospital,
  updateHospital,
  deleteHospital,
} from "../../controllers/IKM/masterRsIkmController.js";

const router = express.Router();

router.get("/hospitals", requireAuth, getHospitals);
router.post("/hospitals", requireAuth, createHospital);
router.put("/hospitals/:id", requireAuth, updateHospital);
router.delete("/hospitals/:id", requireAuth, deleteHospital);

export default router;
