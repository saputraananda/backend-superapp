import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getActiveTimeConfig,
  listAttendanceTimes,
  listGroomingTimes,
  listShiftTimes,
  upsertAttendanceTime,
  upsertGroomingTime,
  upsertShiftTime,
  deleteShiftTime,
} from "../../../controllers/MyWaschen/HRIS/TimeMasterController.js";

const router = express.Router();

/** Bundle aktif — boleh tanpa auth ketat untuk POS/Mobile internal (tetap requireAuth session Alsa) */
router.get("/active", requireAuth, getActiveTimeConfig);

router.use(requireAuth);

router.get("/attendance", listAttendanceTimes);
router.post("/attendance", (req, res) => upsertAttendanceTime(req, res));
router.put("/attendance/:id", upsertAttendanceTime);

router.get("/grooming", listGroomingTimes);
router.post("/grooming", (req, res) => upsertGroomingTime(req, res));
router.put("/grooming/:id", upsertGroomingTime);

router.get("/shifts", listShiftTimes);
router.post("/shifts", (req, res) => upsertShiftTime(req, res));
router.put("/shifts/:id", upsertShiftTime);
router.delete("/shifts/:id", deleteShiftTime);

export default router;
