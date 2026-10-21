import express from "express";
import {
  getCustomers,
  getCustomerById,
  getCustomerMembershipPayments,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "../../../controllers/MyWaschen/Transaction/CustomerController.js";

const router = express.Router();

router.get("/", getCustomers);
router.get("/:id/membership-payments", getCustomerMembershipPayments);
router.get("/:id", getCustomerById);
router.post("/", createCustomer);
router.put("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

export default router;
