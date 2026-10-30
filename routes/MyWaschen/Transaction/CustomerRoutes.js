import express from "express";
import {
  getCustomers,
  getCustomerById,
  getCustomerMembershipPayments,
  getCustomerTransactions,
  getCustomerComplaints,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "../../../controllers/MyWaschen/Transaction/CustomerController.js";

const router = express.Router();

router.get("/", getCustomers);
router.get("/:id/membership-payments", getCustomerMembershipPayments);
router.get("/:id/transactions", getCustomerTransactions);
router.get("/:id/complaints", getCustomerComplaints);
router.get("/:id", getCustomerById);
router.post("/", createCustomer);
router.put("/:id", updateCustomer);
router.delete("/:id", deleteCustomer);

export default router;
