import express from "express";
import {
  getCustomerTiers,
  getCustomerTierById,
  createCustomerTier,
  updateCustomerTier,
  deleteCustomerTier,
} from "../../../controllers/MyWaschen/MasterData/CustomerTierController.js";

const router = express.Router();

router.get("/", getCustomerTiers);
router.get("/:id", getCustomerTierById);
router.post("/", createCustomerTier);
router.put("/:id", updateCustomerTier);
router.delete("/:id", deleteCustomerTier);

export default router;
