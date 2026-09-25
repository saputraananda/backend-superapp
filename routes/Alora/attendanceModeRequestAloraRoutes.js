import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { listModeRequests } from "../../controllers/Alora/attendanceModeRequestAloraController.js";

const router = express.Router();

router.get("/", requireAuth, listModeRequests);

export default router;
