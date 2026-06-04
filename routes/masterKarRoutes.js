import express from "express";
import {
  getDashboardSummary,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  resignEmployee,
  uploadEmployeeDoc,
  deleteEmployeeDoc,
} from "../controllers/masterKarController.js";
import { uploadAvatar, uploadDocument } from "../middleware/upload.js";

const router = express.Router();

router.get("/dashboard",           getDashboardSummary);
router.get("/employees",           listEmployees);
router.get("/employees/:id",       getEmployee);
router.put("/employees/:id",       updateEmployee);
router.delete("/employees/:id",    deleteEmployee);
router.post("/employees/:id/resign", resignEmployee);

router.post("/employees/:id/document/:docType", (req, res, next) => {
  const { docType } = req.params;
  if (docType === "profile") {
    uploadAvatar.single("file")(req, res, next);
  } else {
    uploadDocument.single("file")(req, res, next);
  }
}, uploadEmployeeDoc);

router.delete("/employees/:id/document/:docType", deleteEmployeeDoc);

export default router;