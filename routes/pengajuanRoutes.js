import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadPurchase } from "../middleware/upload.js";
import {
    getSatuan, getCompanies, getOutlets, getVendors, getPeriods, getDepartments,
    getClassifications,
    getDashboard,
    listMy, listDepartment, listApproval, listAll, listGaReview, getDetail,
    listFinanceReview, listPaymentPending,
    listCredit, getPaymentHistory, addInstallment,
    createPR, updatePR, deletePR, deleteAttachment,
    approvePR, rejectPR,
    approveGA, rejectGA, getPOData,
    approveFinance, rejectFinance,
    processPayment, rejectPayment, completePR,
    updatePaymentInfo,
} from "../controllers/pengajuanController.js";

const router = Router();

// ── Master / lookup ──
router.get("/satuan",      requireAuth, getSatuan);
router.get("/companies",   requireAuth, getCompanies);
router.get("/outlets",     requireAuth, getOutlets);
router.get("/vendors",     requireAuth, getVendors);
router.get("/departments", requireAuth, getDepartments);
router.get("/periods",         requireAuth, getPeriods);
router.get("/classifications", requireAuth, getClassifications);

// ── Dashboard & list ──
router.get("/dashboard",            requireAuth, getDashboard);
router.get("/me",                   requireAuth, listMy);
router.get("/department",           requireAuth, listDepartment);
router.get("/approval",             requireAuth, listApproval);
router.get("/all",                  requireAuth, listAll);
router.get("/ga-review",            requireAuth, listGaReview);
router.get("/finance-review",       requireAuth, listFinanceReview);
router.get("/payment-pending",      requireAuth, listPaymentPending);
router.get("/credit",               requireAuth, listCredit);

// ── Payment / installment ──
router.get("/:id/payments",         requireAuth, getPaymentHistory);
router.post("/:id/installment",     requireAuth, uploadPurchase.array("attachments", 1), addInstallment);

// ── Detail & PO ──
router.get("/:id/po",  requireAuth, getPOData);
router.get("/:id",     requireAuth, getDetail);

// ── Create / Update / Delete (oleh pengaju) ──
router.post("/",   requireAuth, uploadPurchase.array("attachments", 10), createPR);
router.put("/:id", requireAuth, uploadPurchase.array("attachments", 10), updatePR);
router.delete("/:id", requireAuth, deletePR);
router.delete("/attachment/:attachmentId", requireAuth, deleteAttachment);

// ── Approval flow ──
router.post("/:id/approve",         requireAuth, approvePR);
router.post("/:id/reject",          requireAuth, rejectPR);
router.post("/:id/approve-ga",      requireAuth, approveGA);
router.post("/:id/reject-ga",       requireAuth, rejectGA);
router.post("/:id/approve-finance", requireAuth, approveFinance);
router.post("/:id/reject-finance",  requireAuth, rejectFinance);

// ── Payment & Completion ──
router.post("/:id/pay",           requireAuth, uploadPurchase.array("attachments", 5), processPayment);
router.post("/:id/reject-payment", requireAuth, rejectPayment);
router.post("/:id/complete",       requireAuth, uploadPurchase.array("attachments", 1), completePR);
router.put("/:id/payment-info",    requireAuth, updatePaymentInfo);

export default router;
