import express from "express";
import {
  getStaffList,
  createStaff,
  updateStaff,
  toggleStaffStatus,
  getTargetConfig,
  saveTargetConfig,
  getStaffMonthProgress,
  getRecommendations,
  createRecommendation,
  updateRecommendation,
  updateFollowUpStatus,
  deleteRecommendation,
  exportCustomerToPos,
  getKpiSummary,
} from "../../controllers/Cleanox/crossSellCleanoxController.js";

const router = express.Router();

// Master Staff Waschen
router.get("/staff", getStaffList);
router.post("/staff", createStaff);
router.put("/staff/:id", updateStaff);
router.patch("/staff/:id/status", toggleStaffStatus);
router.get("/staff/:id/progress", getStaffMonthProgress);

// Target Config
router.get("/target", getTargetConfig);
router.post("/target", saveTargetConfig);

// Transaksi Rekomendasi Cross-Sell
router.get("/recommendations", getRecommendations);
router.post("/recommendations", createRecommendation);
router.put("/recommendations/:id", updateRecommendation);
router.patch("/recommendations/:id/status", updateFollowUpStatus);
router.delete("/recommendations/:id", deleteRecommendation);

// Aksi Tambahkan ke POS
router.post("/recommendations/:id/export-to-pos", exportCustomerToPos);

// Rekap KPI
router.get("/kpi", getKpiSummary);

export default router;
