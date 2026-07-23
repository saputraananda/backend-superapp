import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getKasbons,
  getKasbonDetail,
  getEmployeeOptions,
  getEmployeeSummary,
  createKasbon,
  updateKasbon,
  updateKasbonStatus,
  deleteKasbon,
  addPayment,
  deletePayment,
} from "../../controllers/IKM/kasbonController.js";
import { uploadIKMKasbon } from "../../middleware/upload.js";

const router = express.Router();

function restrictKasbonAccess(req, res, next) {
  const employeeId = Number(
    req.session?.user?.employee?.employee_id ||
    req.session?.user?.employeeId ||
    req.session?.employeeId ||
    0
  );
  const userRole = req.session?.user?.role || req.session?.userRole || "";

  if ([42, 43, 45].includes(employeeId) || userRole === "admin") {
    return next();
  }
  return res.status(403).json({ message: "Anda tidak memiliki akses ke menu Kasbon & Pinjaman" });
}

router.get("/employee-options",  requireAuth, restrictKasbonAccess, getEmployeeOptions);
router.get("/employee-summary",  requireAuth, restrictKasbonAccess, getEmployeeSummary);
router.get("/",                  requireAuth, restrictKasbonAccess, getKasbons);
router.get("/:id", requireAuth, restrictKasbonAccess, getKasbonDetail);
router.post("/", requireAuth, restrictKasbonAccess, uploadIKMKasbon.single("proof_file"), createKasbon);
router.put("/:id", requireAuth, restrictKasbonAccess, uploadIKMKasbon.single("proof_file"), updateKasbon);
router.put("/:id/status", requireAuth, restrictKasbonAccess, updateKasbonStatus);
router.delete("/:id", requireAuth, restrictKasbonAccess, deleteKasbon);
router.post("/:id/payment", requireAuth, restrictKasbonAccess, addPayment);
router.delete("/:id/payment/:paymentId", requireAuth, restrictKasbonAccess, deletePayment);

export default router;
