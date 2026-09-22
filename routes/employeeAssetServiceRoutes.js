import crypto from "crypto";
import express from "express";
import {
  uploadEmployeeAssetService,
  deleteEmployeeAssetService,
} from "../controllers/employeeAssetServiceController.js";
import { uploadAvatar, uploadDocument } from "../middleware/upload.js";

const router = express.Router();

/**
 * Auth antar-server (Waschen Mobile → Alsa). Bukan sesi browser.
 * Token wajib diset di ENV; tanpa itu endpoint mati total.
 */
const requireServiceToken = (req, res, next) => {
  const expected = process.env.SERVICE_UPLOAD_TOKEN || "";
  if (!expected) {
    return res.status(503).json({ message: "Service upload belum dikonfigurasi." });
  }
  const got = String(req.headers["x-service-token"] || "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ message: "Service token tidak valid." });
  }
  next();
};

// Foto profil hanya gambar, dokumen gambar + PDF
const pickUploader = (req, res, next) => {
  const isPhoto = String(req.params.docType || "").toLowerCase() === "profile";
  const handler = isPhoto ? uploadAvatar.single("file") : uploadDocument.single("file");
  handler(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Ukuran file terlalu besar."
          : err.message || "Gagal mengunggah file.";
      return res.status(400).json({ message });
    }
    next();
  });
};

router.post("/:docType", requireServiceToken, pickUploader, uploadEmployeeAssetService);
router.delete("/:docType", requireServiceToken, deleteEmployeeAssetService);

export default router;
