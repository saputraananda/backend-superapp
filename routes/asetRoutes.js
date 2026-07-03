import express from "express";
import {
  getAsets,
  getAsetById,
  getAsetByKode,
  getAsetThumb,
  createAset,
  updateAset,
  deleteAset,
  uploadPhotos,
  deletePhoto,
  getMasterData,
  getStats,
  // Approval
  submitAset,
  approveSpv,
  approveBod,
  rejectAset,
  // Mutasi
  getMutasi,
  createMutasi,
  // Maintenance
  getMaintenance,
  createMaintenance,
  updateMaintenance,
  deleteMaintenance,
  // Peminjaman
  getPeminjaman,
  createPeminjaman,
  updatePeminjaman,
  // Penghapusan
  getPenghapusan,
  createPenghapusan,
} from "../controllers/asetController.js";
import { uploadAsetPhoto } from "../middleware/upload.js";

const router = express.Router();

// Master data & stats
router.get("/master-data", getMasterData);
router.get("/stats", getStats);

// Thumbnail (cached WebP)
router.get("/thumb/:filename", getAsetThumb);

// Lookup by kode (QR scan)
router.get("/kode/:kode", getAsetByKode);

// Photos
router.delete("/photos/:photoId", deletePhoto);

// Maintenance (non-nested update)
router.put("/maintenance/:maintenanceId", updateMaintenance);
router.delete("/maintenance/:maintenanceId", deleteMaintenance);

// Peminjaman (non-nested update)
router.put("/peminjaman/:peminjamanId", updatePeminjaman);

// CRUD aset
router.get("/", getAsets);
router.post("/", createAset);
router.get("/:id", getAsetById);
router.put("/:id", updateAset);
router.delete("/:id", deleteAset);

// Photos upload
router.post("/:id/photos", uploadAsetPhoto.array("photos", 10), uploadPhotos);

// Approval flow
router.post("/:id/submit", submitAset);
router.post("/:id/approve-spv", approveSpv);
router.post("/:id/approve-bod", approveBod);
router.post("/:id/reject", rejectAset);

// Mutasi
router.get("/:id/mutasi", getMutasi);
router.post("/:id/mutasi", createMutasi);

// Maintenance
router.get("/:id/maintenance", getMaintenance);
router.post("/:id/maintenance", createMaintenance);

// Peminjaman
router.get("/:id/peminjaman", getPeminjaman);
router.post("/:id/peminjaman", createPeminjaman);

// Penghapusan
router.get("/:id/penghapusan", getPenghapusan);
router.post("/:id/penghapusan", createPenghapusan);

export default router;