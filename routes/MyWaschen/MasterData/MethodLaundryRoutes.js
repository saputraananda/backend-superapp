import express from "express";
import {
  getMethodLaundries,
  getMethodLaundryById,
  createMethodLaundry,
  updateMethodLaundry,
  deleteMethodLaundry,
} from "../../../controllers/MyWaschen/MasterData/MethodLaundryController.js";

const router = express.Router();

router.get("/", getMethodLaundries);
router.get("/:id", getMethodLaundryById);
router.post("/", createMethodLaundry);
router.put("/:id", updateMethodLaundry);
router.delete("/:id", deleteMethodLaundry);

export default router;
