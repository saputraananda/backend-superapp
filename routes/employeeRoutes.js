import express from "express";
import {
  getProfile,
  updateProfile,
  getMasterData,
  listEmployees,
  uploadProfilePhoto,
  deleteProfilePhoto,
  uploadKtpPhoto,
  deleteKtpPhoto,
} from "../controllers/employeeController.js";
import { uploadAvatar } from "../middleware/upload.js";

const router = express.Router();

router.get("/", listEmployees);
router.get("/profile", getProfile);
router.put("/profile", updateProfile);
router.get("/master-data", getMasterData);

// Photo routes
router.post("/profile/photo", uploadAvatar.single("profile_photo"), uploadProfilePhoto);
router.delete("/profile/photo", deleteProfilePhoto);
router.post("/profile/ktp", uploadAvatar.single("ktp_photo"), uploadKtpPhoto);
router.delete("/profile/ktp", deleteKtpPhoto);

export default router;