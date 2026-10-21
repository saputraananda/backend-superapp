import express from "express";
import { requireAuth } from "../../../middleware/auth.js";
import {
  getSenderDefault,
  getFormLinens,
  listBast,
  getBast,
  createBast,
  updateBast,
  updateLineSpecs,
  deleteBast,
} from "../../../controllers/IKM/LinenTransaction/bastLinenSewaController.js";

const router = express.Router();

router.use(requireAuth);

router.get("/me", getSenderDefault);
router.get("/linens", getFormLinens);
router.get("/", listBast);
router.get("/:id", getBast);
router.post("/", createBast);
router.put("/:id", updateBast);
router.patch("/:id/lines", updateLineSpecs);
router.delete("/:id", deleteBast);

export default router;
