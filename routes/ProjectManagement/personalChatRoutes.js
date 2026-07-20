// routes/ProjectManagement/personalChatRoutes.js
import express from "express";
import {
  listChatContacts,
  listChatMessages,
  sendChatMessage
} from "../../controllers/ProjectManagement/personalChatController.js";

const router = express.Router();

router.get("/contacts",            listChatContacts);
router.get("/messages/:contactId",  listChatMessages);
router.post("/messages",           sendChatMessage);

export default router;
