import express from "express";
import {
  getCustomerSources,
  getCustomerSourceById,
  createCustomerSource,
  updateCustomerSource,
  deleteCustomerSource,
} from "../../../controllers/MyWaschen/MasterData/CustomerSourceController.js";

const router = express.Router();

router.get("/", getCustomerSources);
router.get("/:id", getCustomerSourceById);
router.post("/", createCustomerSource);
router.put("/:id", updateCustomerSource);
router.delete("/:id", deleteCustomerSource);

export default router;
