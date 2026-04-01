import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { uploadTasklistEvidence } from "../middleware/upload.js";
import {
  getTasklists,
  createTasklist,
  updateTasklist,
  deleteTasklist,
  toggleItem,
  uploadItemEvidence,
  uploadEvidence,
  getCompanies,
  searchEmployees,
} from "../controllers/personalTasklistController.js";

const router = express.Router();

router.get("/", requireAuth, getTasklists);
router.post("/", requireAuth, createTasklist);
router.put("/:id", requireAuth, updateTasklist);
router.delete("/:id", requireAuth, deleteTasklist);

router.patch("/item/:itemId/toggle", requireAuth, toggleItem);
router.post("/item/:itemId/evidence", requireAuth, uploadTasklistEvidence.single("file"), uploadItemEvidence);
router.post("/upload-evidence", requireAuth, uploadTasklistEvidence.single("file"), uploadEvidence);

router.get("/companies", requireAuth, getCompanies);
router.get("/employees", requireAuth, searchEmployees);

export default router;
