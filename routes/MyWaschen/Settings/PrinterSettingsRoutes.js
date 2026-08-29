import { Router } from "express";
import {
  getPrinterSettings,
  savePrinterSettings,
  getPreviewReceipt,
} from "../../../controllers/MyWaschen/Settings/PrinterSettingsController.js";

const router = Router();

router.get("/preview-receipt", getPreviewReceipt);
router.get("/", getPrinterSettings);
router.put("/", savePrinterSettings);

export default router;
