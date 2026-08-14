import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getAll,
  create,
  update,
  remove,
} from "../../controllers/IKM/masterRoomsIKMController.js";

const router = express.Router();

router.get("/rooms", requireAuth, getAll);
router.post("/rooms", requireAuth, create);
router.put("/rooms/:id", requireAuth, update);
router.delete("/rooms/:id", requireAuth, remove);

export default router;
