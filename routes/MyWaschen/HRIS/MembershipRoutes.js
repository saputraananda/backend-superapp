import express from "express";
import { getMemberships, getMembershipPayments } from "../../../controllers/MyWaschen/HRIS/MembershipController.js";

const router = express.Router();

router.get("/", getMemberships);
router.get("/:customerId/payments", getMembershipPayments);

export default router;
