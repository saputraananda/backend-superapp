import express from "express";
import path from "path";
import multer from "multer";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getKasbonList,
  getKasbonMonitor,
  getKasbonMonitorDetail,
  getKasbonById,
  processKasbon,
  approveKasbon,
  rejectKasbon,
  addKasbonPayment,
  markKasbonInstallmentPaid,
  createOpeningBalance,
} from "../../../controllers/MyWaschen/HRIS/KasbonController.js";

// File tidak ditulis ke disk Alsa — diteruskan ke server Waschen Mobile
// (satu sumber dengan bukti pengajuan kasbon di /uploads/assets/kasbon).
const paymentProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    const okExt = [".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(ext);
    const okMime = ext === ".pdf"
      ? mime === "application/pdf"
      : /^image\/(jpeg|jpg|png|webp)$/.test(mime);
    if (okExt && okMime) return cb(null, true);
    cb(new Error("Bukti harus gambar (jpg, png, webp) atau PDF."));
  },
});

function uploadPaymentProof(req, res, next) {
  paymentProof.single("proof")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Ukuran bukti terlalu besar (maks 6MB)."
      : (err.message || "Gagal mengunggah bukti.");
    return res.status(400).json({ success: false, message });
  });
}

const router = express.Router();
router.use(requireAuth);
router.get("/", getKasbonList);
router.get("/monitor", getKasbonMonitor);
router.get("/monitor/:employeeId", getKasbonMonitorDetail);
router.post("/opening", createOpeningBalance);
router.get("/:id", getKasbonById);
router.patch("/:id/process", processKasbon);
router.patch("/:id/approve", approveKasbon);
router.patch("/:id/reject", rejectKasbon);
router.post("/:id/payments", addKasbonPayment);
router.patch("/:id/payments/:paymentId/paid", uploadPaymentProof, markKasbonInstallmentPaid);
export default router;
