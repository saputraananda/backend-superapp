import express from "express";
import {
  getMembershipPackages,
  getMembershipPackageById,
  createMembershipPackage,
  updateMembershipPackage,
  deleteMembershipPackage,
} from "../../../controllers/MyWaschen/MasterData/MembershipPackageController.js";

const router = express.Router();

router.get("/", getMembershipPackages);
router.get("/:id", getMembershipPackageById);
router.post("/", createMembershipPackage);
router.put("/:id", updateMembershipPackage);
router.delete("/:id", deleteMembershipPackage);

export default router;
