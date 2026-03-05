import { Router } from "express";
import {
  listBroadcasts,
  listAllBroadcasts,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
} from "../controllers/broadcastController.js";

const router = Router();

router.get   ("/",        listBroadcasts);     // publik — semua karyawan
router.get   ("/all",     listAllBroadcasts);  // admin — semua data
router.post  ("/",        createBroadcast);    // buat baru
router.patch ("/:id",     updateBroadcast);    // edit
router.delete("/:id",     deleteBroadcast);    // hapus

export default router;