import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getEventOutlets,
  getEventDashboard,
  getEventCustomers,
} from "../../../controllers/MyWaschen/EventB2B/EventB2BController.js";

const router = express.Router();

router.get("/outlets", requireAuth, getEventOutlets);
router.get("/dashboard", requireAuth, getEventDashboard);
router.get("/customers", requireAuth, getEventCustomers);

export default router;
