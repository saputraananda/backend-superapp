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
  getGeneralLedger,
} from "../../controllers/FinanceHO/financeJournalController.js";

const router = express.Router();

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
