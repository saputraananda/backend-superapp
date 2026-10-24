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
  getHospitalKgPriceLogs,
  getUnitUsers,
  createUnitUser,
  updateUnitUser,
  toggleUnitUser,
  deleteUnitUser,
} from "../../controllers/IKM/masterRsIkmController.js";

const router = express.Router();

router.get("/hospitals", requireAuth, getHospitals);
router.get("/hospitals/:id/kg-price-logs", requireAuth, getHospitalKgPriceLogs);
router.post("/hospitals", requireAuth, createHospital);
router.put("/hospitals/:id", requireAuth, updateHospital);
router.delete("/hospitals/:id", requireAuth, deleteHospital);

router.post("/hospitals/:hospitalId/rooms", requireAuth, createRoom);
router.put("/hospitals/rooms/:roomId", requireAuth, updateRoom);
router.delete("/hospitals/rooms/:roomId", requireAuth, deleteRoom);

router.get("/hospitals/:hospitalId/unit-users", requireAuth, getUnitUsers);
router.post("/hospitals/:hospitalId/unit-users", requireAuth, createUnitUser);
router.put("/hospitals/unit-users/:userId", requireAuth, updateUnitUser);
router.post("/hospitals/unit-users/:userId/toggle", requireAuth, toggleUnitUser);
router.delete("/hospitals/unit-users/:userId", requireAuth, deleteUnitUser);

export default router;
