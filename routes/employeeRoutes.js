import express from "express";
import {
  getProfile,
  updateProfile,
  getMasterData,
  listEmployees,
  uploadProfilePhoto,
  deleteProfilePhoto,
  uploadDoc,
  deleteDoc,
} from "../controllers/employeeController.js";
import { uploadAvatar, uploadDocument } from "../middleware/upload.js";

const router = express.Router();

router.get("/", listEmployees);
router.get("/profile", getProfile);
router.put("/profile", updateProfile);
router.get("/master-data", getMasterData);

// Pas foto — tetap hanya gambar
router.post("/profile/photo", uploadAvatar.single("profile_photo"), uploadProfilePhoto);
router.delete("/profile/photo", deleteProfilePhoto);

// Semua dokumen (KTP, KK, NPWP, BPJS, dst) — gambar + PDF
router.post("/profile/document/:docType", uploadDocument.single("file"), uploadDoc);
router.delete("/profile/document/:docType", deleteDoc);

export default router;