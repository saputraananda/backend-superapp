import express from "express";
import {
  getAccounts,
  getAccountsForSelect,
  createAccount,
  updateAccount,
  seedDefaultAccounts,
  getJournals,
  getJournalDetail,
  createJournal,
  reverseJournal,
} from "../../controllers/FinanceHO/financeJournalController.js";
import { requireAuth } from "../../middleware/auth.js";

const router = express.Router();

// ── Master Bagan Akun (Chart of Accounts) ──────────
router.get("/accounts", requireAuth, getAccounts);
router.get("/accounts/select", requireAuth, getAccountsForSelect);
router.post("/accounts", requireAuth, createAccount);
router.put("/accounts/:id", requireAuth, updateAccount);
router.post("/accounts/seed-default", requireAuth, seedDefaultAccounts);

// ── Transaksi Jurnal Umum ───────────────────────────
router.get("/journals", requireAuth, getJournals);
router.get("/journals/:id", requireAuth, getJournalDetail);
router.post("/journals", requireAuth, createJournal);
router.post("/journals/:id/reverse", requireAuth, reverseJournal);

export default router;

