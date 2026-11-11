import express from "express";
import { safeQuery } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { uploadAcademyMaterial } from "../middleware/upload.js";
import { isHRDUser } from "../controllers/trainingController.js";
import {
  getTrainings,
  getTrainingById,
  createTraining,
  updateTraining,
  createTopic,
  updateTopic,
  saveContent,
  uploadMaterial,
  deleteMaterial,
} from "../controllers/academy/trainingMasterController.js";
import {
  getRoleOptions,
  getPositions,
  createPosition,
  updatePosition,
  saveStructure,
  getLoOptions,
  getLoAssignments,
  createLoAssignment,
  updateLoAssignment,
} from "../controllers/academy/skillMasterController.js";
import {
  getBatchOptions,
  getRequestPrefill,
  getBatches,
  getBatchById,
  createBatch,
  updateBatch,
  cancelBatch,
  setAttendance,
  closeParticipant,
  getMentorForm,
  saveMentorScores,
  getEssays,
  gradeEssays,
  getParticipantAnswers,
} from "../controllers/academy/batchController.js";
import {
  getOjtCriteria,
  createOjtCriterion,
  updateOjtCriterion,
  createOjtSubskill,
  reorderOjtSubskills,
  updateOjtSubskill,
  getOjtOptions,
  getOjtList,
  getOjtById,
  createOjt,
  updateOjt,
} from "../controllers/academy/ojtController.js";
import { getTrainingDashboard, getSkillDashboard } from "../controllers/academy/dashboardController.js";

const router = express.Router();

// requireAuth hanya mengecek login, sedangkan kartu TMS bisa dibuka 11 role. Academy hanya untuk HR.
const requireAcademyHR = async (req, res, next) => {
  try {
    const [rows] = await safeQuery(
      `SELECT position_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1`,
      [req.session.employeeId]
    );
    if (!isHRDUser(rows[0])) return res.status(403).json({ message: "Menu ini hanya untuk HR" });
    next();
  } catch (err) {
    next(err);
  }
};

// Error upload (tipe atau ukuran file) dikirim sebagai 400 supaya pesannya sampai ke HR.
const acceptMaterial = (req, res, next) => {
  uploadAcademyMaterial.single("file")(req, res, (err) =>
    err ? res.status(400).json({ message: err.message }) : next()
  );
};

router.use(requireAuth, requireAcademyHR);

router.get("/trainings", getTrainings);
router.post("/trainings", createTraining);
router.get("/trainings/:id", getTrainingById);
router.put("/trainings/:id", updateTraining);
router.put("/trainings/:id/content", saveContent);
router.post("/trainings/:id/topics", createTopic);
router.put("/topics/:topicId", updateTopic);
router.post("/trainings/:id/materials", acceptMaterial, uploadMaterial);
router.delete("/materials/:materialId", deleteMaterial);

router.get("/skill/roles", getRoleOptions);
router.get("/skill/positions", getPositions);
router.post("/skill/positions", createPosition);
router.put("/skill/positions/:id", updatePosition);
router.put("/skill/positions/:id/structure", saveStructure);

router.get("/lo/options", getLoOptions);
router.get("/lo", getLoAssignments);
router.post("/lo", createLoAssignment);
router.put("/lo/:id", updateLoAssignment);

router.get("/batch-options", getBatchOptions);
router.get("/requests/:id/prefill", getRequestPrefill);
router.get("/batches", getBatches);
router.post("/batches", createBatch);
router.get("/batches/:id", getBatchById);
router.put("/batches/:id", updateBatch);
router.post("/batches/:id/cancel", cancelBatch);
router.put("/participants/:id/attendance", setAttendance);
router.post("/participants/:id/close", closeParticipant);
router.get("/participants/:id/mentor-scores", getMentorForm);
router.put("/participants/:id/mentor-scores", saveMentorScores);
router.get("/participants/:id/essays", getEssays);
router.put("/participants/:id/essays", gradeEssays);
router.get("/participants/:id/answers", getParticipantAnswers);

router.get("/ojt/criteria", getOjtCriteria);
router.post("/ojt/criteria", createOjtCriterion);
router.put("/ojt/criteria/:id", updateOjtCriterion);
router.post("/ojt/criteria/:id/subskills", createOjtSubskill);
router.put("/ojt/criteria/:id/subskills/order", reorderOjtSubskills);
router.put("/ojt/subskills/:id", updateOjtSubskill);
router.get("/ojt/options", getOjtOptions);
router.get("/ojt", getOjtList);
router.post("/ojt", createOjt);
router.get("/ojt/:id", getOjtById);
router.put("/ojt/:id", updateOjt);

router.get("/dashboard/training", getTrainingDashboard);
router.get("/dashboard/skill", getSkillDashboard);

export default router;
