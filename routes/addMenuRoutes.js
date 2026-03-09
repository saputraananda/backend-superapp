import express from "express";
import {
  getApps,
  getAppById,
  createApp,
  updateApp,
  deleteApp,
} from "../controllers/addMenuController.js";

const router = express.Router();

router.get("/",       getApps);
router.get("/:id",    getAppById);
router.post("/",      createApp);
router.put("/:id",    updateApp);
router.delete("/:id", deleteApp);

export default router;