import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import { getActiveOutlets } from "../../controllers/MyWaschen/masterController.js";
import { getOutlets, getAllOutlets, createOutlet, updateOutlet, deleteOutlet } from "../../controllers/MyWaschen/outletController.js";
import { getUsers, registerUser, updateUser, deleteUser, getRoles } from "../../controllers/MyWaschen/userController.js";
import { getServices, getServiceCategories, createService, updateService, deleteService } from "../../controllers/MyWaschen/serviceController.js";
import { getPromos, createPromo, updatePromo, deletePromo } from "../../controllers/MyWaschen/promoController.js";
import { getInventoryItems, getInventoryCategories, createInventoryItem, updateInventoryItem, deleteInventoryItem, getInventoryStocks, adjustStock } from "../../controllers/MyWaschen/inventoryController.js";
import { getTargets, saveTarget, getDailyProgress } from "../../controllers/MyWaschen/targetController.js";
import { getPeriods, closePeriod } from "../../controllers/MyWaschen/periodController.js";
import { getSessions, getSubSessions, getHandovers } from "../../controllers/MyWaschen/shiftController.js";
import { getExpenses, getDeposits, getWalletLedgers } from "../../controllers/MyWaschen/financeController.js";
import { getTransactionReport, getPaymentReport, getLogisticReport } from "../../controllers/MyWaschen/reportsController.js";
import { getDashboardStats, getAdminCharts } from "../../controllers/MyWaschen/dashboardController.js";
import { getPendingApprovals, resolveApproval, approveCashDeposit, rejectCashDeposit, approveExpense, rejectExpense } from "../../controllers/MyWaschen/approvalController.js";
import { getPurchaseRequests, createPurchaseRequest, updatePurchaseStatus } from "../../controllers/MyWaschen/purchaseController.js";
import { getUpcomingBirthdays, sendBirthdayPromo } from "../../controllers/MyWaschen/birthdayController.js";
import { getErrorLogs, resolveError } from "../../controllers/MyWaschen/errorController.js";
import { getAuditLogs } from "../../controllers/MyWaschen/auditController.js";
import { getSettings, saveSettings } from "../../controllers/MyWaschen/settingsController.js";

const router = express.Router();

// Apply requireAuth middleware to protect all routes
router.use(requireAuth);

// ── Master ──
router.get("/master/outlets", getActiveOutlets);
router.get("/settings", getSettings);
router.post("/settings", saveSettings);

// ── Outlets ──
router.get("/outlets", getOutlets);
router.get("/outlets/admin/all", getAllOutlets);
router.post("/outlets", createOutlet);
router.put("/outlets/:id", updateOutlet);
router.delete("/outlets/:id", deleteOutlet);

// ── Users ──
router.get("/users", getUsers);
router.post("/users/register", registerUser);
router.put("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);
router.get("/users/roles/list", getRoles);

// ── Services ──
router.get("/services", getServices);
router.get("/services/categories/list", getServiceCategories);
router.post("/services", createService);
router.put("/services/:id", updateService);
router.delete("/services/:id", deleteService);

// ── Promos ──
router.get("/promos", getPromos);
router.post("/promos", createPromo);
router.put("/promos/:id", updatePromo);
router.delete("/promos/:id", deletePromo);

// ── Inventory ──
router.get("/inventory/items", getInventoryItems);
router.get("/inventory/categories/list", getInventoryCategories);
router.post("/inventory/items", createInventoryItem);
router.put("/inventory/items/:id", updateInventoryItem);
router.delete("/inventory/items/:id", deleteInventoryItem);
router.get("/inventory/stocks", getInventoryStocks);
router.post("/inventory/adjust", adjustStock);

// ── Targets ──
router.get("/targets", getTargets);
router.post("/targets", saveTarget);
router.get("/targets/daily-progress", getDailyProgress);

// ── Period Closing ──
router.get("/periods", getPeriods);
router.post("/periods/close", closePeriod);

// ── Shifts ──
router.get("/shifts/sessions", getSessions);
router.get("/shifts/sub-sessions", getSubSessions);
router.get("/shifts/handovers", getHandovers);

// ── Finance ──
router.get("/finance/expenses", getExpenses);
router.post("/finance/expenses/:id/approve", approveExpense);
router.post("/finance/expenses/:id/reject", rejectExpense);
router.get("/finance/deposits", getDeposits);
router.get("/finance/wallet-ledgers", getWalletLedgers);

// ── Reports ──
router.get("/reports/transactions", getTransactionReport);
router.get("/reports/payments", getPaymentReport);
router.get("/reports/logistics", getLogisticReport);

// ── Dashboard ──
router.get("/dashboard/stats", getDashboardStats);
router.get("/admin-dashboard/charts", getAdminCharts);

// ── Approvals ──
router.get("/approvals", getPendingApprovals);
router.post("/approvals/:id/resolve", resolveApproval);
router.post("/cash-deposits/:id/approve", approveCashDeposit);
router.post("/cash-deposits/:id/reject", rejectCashDeposit);

// ── Purchase Requests ──
router.get("/purchase-requests", getPurchaseRequests);
router.post("/purchase-requests", createPurchaseRequest);
router.put("/purchase-requests/:id/status", updatePurchaseStatus);

// ── Birthday Campaign ──
router.get("/birthday/upcoming", getUpcomingBirthdays);
router.post("/birthday/send-promo", sendBirthdayPromo);

// ── Errors Tracking ──
router.get("/errors", getErrorLogs);
router.post("/errors/:id/resolve", resolveError);

// ── Audit Trail ──
router.get("/audit", getAuditLogs);

export default router;
