import express from "express";
import path from "path";
import multer from "multer";
import {
  getTransactions,
  getTransactionById,
  getTransactionSummary,
  updateTransactionPayment,
  requestDeleteTransaction,
  approveDeleteTransaction,
  approveRefundTransaction,
  updateFulfillment,
  updateItemWorkStatus,
} from "../../../controllers/MyWaschen/Transaction/HistoryController.js";

// Lampiran hapus nota tidak ditulis ke disk Alsa — diteruskan ke server POS (/uploads/assets/delete-request)
const deleteAttachment = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    const okExt = [".jpg", ".jpeg", ".png", ".webp", ".pdf"].includes(ext);
    const okMime = ext === ".pdf"
      ? mime === "application/pdf"
      : /^image\/(jpeg|jpg|png|webp)$/.test(mime);
    if (okExt && okMime) return cb(null, true);
    cb(new Error("Lampiran harus gambar (jpg, png, webp) atau PDF."));
  },
});

function uploadDeleteAttachment(req, res, next) {
  deleteAttachment.single("attachment")(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE"
      ? "Ukuran lampiran terlalu besar (maks 5MB)."
      : (err.message || "Gagal mengunggah lampiran.");
    return res.status(400).json({ success: false, message });
  });
}

const router = express.Router();

router.get("/summary", getTransactionSummary);
router.get("/", getTransactions);
router.get("/:id", getTransactionById);
router.patch("/:id/payment", updateTransactionPayment);
router.patch("/:id/request-delete", uploadDeleteAttachment, requestDeleteTransaction);
router.patch("/:id/approve-delete", approveDeleteTransaction);
router.patch("/:id/approve-refund", approveRefundTransaction);
router.patch("/:id/fulfillment", updateFulfillment);
router.put("/:id/fulfillment", updateFulfillment);
router.patch("/:id/items/:itemId/status", updateItemWorkStatus);

export default router;
