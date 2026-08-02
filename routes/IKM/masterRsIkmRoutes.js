import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getHospitals,
  createHospital,
  updateHospital,
  deleteHospital,
  createRoom,
  updateRoom,
  deleteRoom,
} from "../../controllers/IKM/masterRsIkmController.js";

const router = express.Router();

router.get("/hospitals", requireAuth, getHospitals);
router.post("/hospitals", requireAuth, createHospital);
router.put("/hospitals/:id", requireAuth, updateHospital);
router.delete("/hospitals/:id", requireAuth, deleteHospital);

router.post("/hospitals/:hospitalId/rooms", requireAuth, createRoom);
router.put("/hospitals/rooms/:roomId", requireAuth, updateRoom);
router.delete("/hospitals/rooms/:roomId", requireAuth, deleteRoom);

export default router;
