import express from "express";
import { requireAuth } from "../../middleware/auth.js";
import {
  getByHospital,
  getAllLinen,
  create,
  update,
  remove,
} from "../../controllers/IKM/hospitalLinenController.js";

const router = express.Router();

// /ikm/hospital-linen/linen-list — shared
router.get("/linen-list",                     requireAuth, getAllLinen);

// /ikm/hospital-linen/:hospitalId/...
router.get("/:hospitalId",                    requireAuth, getByHospital);
router.post("/:hospitalId",                   requireAuth, create);
router.put("/:hospitalId/:id",                requireAuth, update);
router.delete("/:hospitalId/:id",             requireAuth, remove);

export default router;
