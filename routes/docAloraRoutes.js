import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadDocAlora } from "../middleware/upload.js";
import {
  getDashboard,
  listDocuments, getDocument, createDocument, updateDocument, deleteDocument,
  deleteAttachment,
  listTransactions, getTransaction, createTransaction, updateTransaction,
  returnDocument, approveTransaction, deleteTransaction,
  lookupEmployees, lookupDepartments, lookupCompanies, lookupDocuments,
} from "../controllers/docAloraController.js";

const router = Router();

// ── Dashboard ──
router.get("/dashboard", requireAuth, getDashboard);

// ── Lookup (dropdown) ──
router.get("/lookup/employees",   requireAuth, lookupEmployees);
router.get("/lookup/departments", requireAuth, lookupDepartments);
router.get("/lookup/companies",   requireAuth, lookupCompanies);
router.get("/lookup/documents",   requireAuth, lookupDocuments);

// ── Master Document CRUD ──
router.get("/documents",     requireAuth, listDocuments);
router.get("/documents/:id", requireAuth, getDocument);
router.post("/documents",    requireAuth, uploadDocAlora.array("attachments", 10), createDocument);
router.put("/documents/:id", requireAuth, uploadDocAlora.array("attachments", 10), updateDocument);
router.delete("/documents/:id", requireAuth, deleteDocument);
router.delete("/attachments/:id", requireAuth, deleteAttachment);

// ── Transaction CRUD ──
router.get("/transactions",     requireAuth, listTransactions);
router.get("/transactions/:id", requireAuth, getTransaction);
router.post("/transactions",    requireAuth, createTransaction);
router.put("/transactions/:id", requireAuth, updateTransaction);
router.post("/transactions/:id/return",  requireAuth, returnDocument);
router.post("/transactions/:id/approve", requireAuth, approveTransaction);
router.delete("/transactions/:id",       requireAuth, deleteTransaction);

export default router;
