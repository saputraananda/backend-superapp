import express from "express";
import {
  getAsets,
  getAsetById,
  getAsetByKode,
  createAset,
  updateAset,
  deleteAset,
  uploadPhotos,
  deletePhoto,
  getMasterData,
  getStats,
} from "../controllers/asetController.js";
import { uploadAsetPhoto } from "../middleware/upload.js";

const router = express.Router();

router.get("/master-data", getMasterData);
router.get("/stats", getStats);
router.get("/kode/:kode", getAsetByKode);
router.get("/:id", getAsetById);
router.get("/", getAsets);
router.post("/", createAset);
router.put("/:id", updateAset);
router.delete("/photos/:photoId", deletePhoto);
router.delete("/:id", deleteAset);
router.post("/:id/photos", uploadAsetPhoto.array("photos", 10), uploadPhotos);

export default router;