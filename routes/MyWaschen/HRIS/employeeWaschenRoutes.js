import express from "express";
import multer from "multer";
import { requireAuth } from "../../../middleware/auth.js";
import {
  listWaschenEmployees,
  getAssignableEmployees,
  addWaschenEmployee,
  updateEmployeeRole,
  getWaschenEmployee,
} from "../../../controllers/MyWaschen/HRIS/employeeWaschenController.js";
import {
  listWaschenPayslips,
  uploadWaschenPayslip,
  viewWaschenPayslip,
  deleteWaschenPayslip,
} from "../../../controllers/MyWaschen/HRIS/payslipWaschenController.js";

const router = express.Router();

const payslipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ok = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(String(file.mimetype || ""));
    cb(ok ? null : new Error("Slip gaji harus PDF atau gambar (jpg, png, webp)."), ok);
  },
});

router.get("/", requireAuth, listWaschenEmployees);
router.get("/assignable", requireAuth, getAssignableEmployees);
router.post("/", requireAuth, addWaschenEmployee);
router.get("/:id/payslips", requireAuth, listWaschenPayslips);
router.post("/:id/payslips", requireAuth, (req, res, next) => {
  payslipUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || "File tidak valid" });
    return next();
  });
}, uploadWaschenPayslip);
router.get("/:id/payslips/:payslipId/view", requireAuth, viewWaschenPayslip);
router.delete("/:id/payslips/:payslipId", requireAuth, deleteWaschenPayslip);
router.put("/:id/role", requireAuth, updateEmployeeRole);
router.get("/:id", requireAuth, getWaschenEmployee);

export default router;
