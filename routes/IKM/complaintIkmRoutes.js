import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  listComplaints,
  getComplaint,
  updateComplaintStatus,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from "../../controllers/IKM/complaintIkmController.js";

const router = express.Router();

// Kategori harus didaftarkan sebelum "/:id"
router.get("/categories", requireAuth, listCategories);
router.post("/categories", requireAuth, createCategory);
router.put("/categories/:id", requireAuth, updateCategory);
router.delete("/categories/:id", requireAuth, deleteCategory);

router.get("/", requireAuth, listComplaints);
router.get("/:id", requireAuth, getComplaint);
router.post("/:id/status", requireAuth, updateComplaintStatus);

export default router;
