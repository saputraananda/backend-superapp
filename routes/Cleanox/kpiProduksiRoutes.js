import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getKpiSummary,
  getKpiDetail,
  getAvailablePeriods,
  getKpiOutlets,
  getSlaItems,
  exportSlaItems,
  getKpiOnlySummary,
  getKpiOnlyDetail,
  getKpiOnlyAvailablePeriods,
} from "../../controllers/Cleanox/kpiProduksiController.js";

const router = express.Router();

router.get("/summary", requireAuth, getKpiSummary);
router.get("/detail", requireAuth, getKpiDetail);
router.get("/available-periods", requireAuth, getAvailablePeriods);
router.get("/outlets", requireAuth, getKpiOutlets);
router.get("/sla-items", requireAuth, getSlaItems);
router.get("/sla-items/export", requireAuth, exportSlaItems);

router.get("/only/summary", requireAuth, getKpiOnlySummary);
router.get("/only/detail", requireAuth, getKpiOnlyDetail);
router.get("/only/available-periods", requireAuth, getKpiOnlyAvailablePeriods);

export default router;
