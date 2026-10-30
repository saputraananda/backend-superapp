import express from "express";
import { getFinanceDashboard } from "../../controllers/FinanceHO/dashboardController.js";
import {
  getBudgets,
  saveBudget,
  saveBatchBudgets,
  copyPreviousMonthBudget,
} from "../../controllers/FinanceHO/budgetsController.js";
import {
  getAccounts,
  getAccountsForSelect,
  createAccount,
  updateAccount,
  seedDefaultAccounts,
} from "../../controllers/FinanceHO/coaController.js";
import {
  getJournals,
  getJournalDetail,
  createJournal,
  reverseJournal,
} from "../../controllers/FinanceHO/financeJournalController.js";
import { getGeneralLedger } from "../../controllers/FinanceHO/generalLedgerController.js";

const router = express.Router();

// ── Dashboard Eksekutif Keuangan ────────────────────
router.get("/dashboard", getFinanceDashboard);

// ── Anggaran Beban (Budgets) ────────────────────────
router.get("/budgets", getBudgets);
router.post("/budgets", saveBudget);
router.post("/budgets/batch", saveBatchBudgets);
router.post("/budgets/copy-previous", copyPreviousMonthBudget);

// ── Master Bagan Akun (Chart of Accounts) ──────────
router.get("/accounts", getAccounts);
router.get("/accounts/select", getAccountsForSelect);
router.post("/accounts", createAccount);
router.put("/accounts/:id", updateAccount);
router.post("/accounts/seed-default", seedDefaultAccounts);

// ── Transaksi Jurnal Umum ───────────────────────────
router.get("/journals"
  , getJournals);
router.get("/journals/:id", getJournalDetail);
router.post("/journals", createJournal);
router.post("/journals/:id/reverse", reverseJournal);

// ── Buku Besar (General Ledger) ─────────────────────
router.get("/general-ledger", getGeneralLedger);

export default router;
