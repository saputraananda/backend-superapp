import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// Base dir (DEV vs PROD)
// =========================
const isProd = process.env.NODE_ENV === "production";

// DEV: simpan di repo -> backend/assets/...
const DEFAULT_DEV_BASE = path.join(__dirname, "..", "assets");

// PROD: simpan di luar repo biar gak kehapus saat deploy
// Bisa di-override via ENV: UPLOAD_BASE_DIR
const DEFAULT_PROD_BASE = process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/";

// Base final
const BASE_DIR = isProd ? DEFAULT_PROD_BASE : DEFAULT_DEV_BASE;

// =========================
// Folder upload
// =========================

// Folder: <BASE>/evidence/
const UPLOAD_DIR = path.join(BASE_DIR, "evidence");

// Folder: <BASE>/avatars/
const AVATAR_DIR = path.join(BASE_DIR, "avatars");

// Folder: <BASE>/documents/
const DOCUMENT_DIR = path.join(BASE_DIR, "documents");

// Folder: <BASE>/daily_evidence/
const DAILY_EVIDENCE_DIR = path.join(BASE_DIR, "daily_evidence");

// Folder: <BASE>/aset_photos/
const ASET_PHOTO_DIR = path.join(BASE_DIR, "aset_photos");
if (!fs.existsSync(ASET_PHOTO_DIR)) fs.mkdirSync(ASET_PHOTO_DIR, { recursive: true });

// Folder: <BASE>/buktiLO/
const BUKTILO_DIR = path.join(BASE_DIR, "buktiLO");
if (!fs.existsSync(BUKTILO_DIR)) fs.mkdirSync(BUKTILO_DIR, { recursive: true });

// Buat folder kalau belum ada
[UPLOAD_DIR, AVATAR_DIR, DOCUMENT_DIR, DAILY_EVIDENCE_DIR, ASET_PHOTO_DIR, BUKTILO_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// =========================
// Storage untuk evidence
// =========================
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 80);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

// =========================
// Storage untuk avatar & KTP (hanya gambar)
// =========================
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}${ext}`);
  },
});

// =========================
// Storage untuk dokumen (PDF + gambar)
// =========================
const documentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCUMENT_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}${ext}`);
  },
});

// =========================
// Storage untuk daily evidence (semua tipe, 20 MB)
// =========================
const dailyEvidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DAILY_EVIDENCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

// =========================
// Filter: hanya gambar
// =========================
const imageFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Hanya file gambar (jpg, png, webp) yang diizinkan."));
  }
};

// =========================
// Filter: gambar + PDF
// =========================
const documentFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp|pdf/;
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Hanya file JPG, PNG, WEBP, atau PDF yang diizinkan."));
  }
};

// =========================
// Filter: semua file (evidence)
// =========================
const fileFilter = (_req, file, cb) => {
  cb(null, true);
};

// =========================
// Upload evidence (semua tipe, 20 MB)
// =========================
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// =========================
// Upload avatar & KTP (hanya gambar, 5 MB)
// =========================
export const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// =========================
// Upload dokumen (gambar + PDF, 10 MB)
// =========================
export const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload daily evidence (semua tipe, 20 MB)
// =========================
export const uploadDailyEvidence = multer({
  storage: dailyEvidenceStorage,
  fileFilter: (_req, file, cb) => cb(null, true), // semua tipe file
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
});

// =========================
// Upload aset photos (gambar, max 10 MB per file, max 10 files)
// =========================
const asetPhotoStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ASET_PHOTO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadAsetPhoto = multer({
  storage: asetPhotoStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload tasklist evidence (semua tipe, 10 MB)
// =========================
const TASKLIST_EVIDENCE_DIR = path.join(BASE_DIR, "tasklist_evidence");
if (!fs.existsSync(TASKLIST_EVIDENCE_DIR)) fs.mkdirSync(TASKLIST_EVIDENCE_DIR, { recursive: true });

const tasklistEvidenceStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TASKLIST_EVIDENCE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadTasklistEvidence = multer({
  storage: tasklistEvidenceStorage,
  fileFilter: (_req, file, cb) => cb(null, true),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload BUKTILO Leader Operasional (gambar, max 10 MB per file)
// =========================
const buktiLOStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, BUKTILO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadBuktiLO = multer({
  storage: buktiLOStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload IKM Linen Report attachment (gambar + PDF, 10 MB)
// =========================
const IKM_LINEN_DIR = path.join(BASE_DIR, "ikm_linen");
if (!fs.existsSync(IKM_LINEN_DIR)) fs.mkdirSync(IKM_LINEN_DIR, { recursive: true });

const ikmLinenStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IKM_LINEN_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadIKMLinen = multer({
  storage: ikmLinenStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload IKM Briefing Document (gambar + PDF, 10 MB)
// =========================
const IKM_BRIEFING_DIR = path.join(BASE_DIR, "ikm_briefing");
if (!fs.existsSync(IKM_BRIEFING_DIR)) fs.mkdirSync(IKM_BRIEFING_DIR, { recursive: true });

const ikmBriefingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IKM_BRIEFING_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadIKMBriefing = multer({
  storage: ikmBriefingStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload Complaint (semua ekstensi, max 5 MB per file)
// =========================
const COMPLAINT_DOC_DIR = path.join(BASE_DIR, "complaint_docs");
if (!fs.existsSync(COMPLAINT_DOC_DIR)) fs.mkdirSync(COMPLAINT_DOC_DIR, { recursive: true });

const complaintDocStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, COMPLAINT_DOC_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadComplaintDoc = multer({
  storage: complaintDocStorage,
  fileFilter: (_req, file, cb) => cb(null, true), // semua ekstensi
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
});

// =========================
// Upload Purchase Request (Pengajuan/Reimburse) attachment
// (gambar + PDF, max 10 MB per file)
// =========================
const PURCHASE_DIR = path.join(BASE_DIR, "purchase");
if (!fs.existsSync(PURCHASE_DIR)) fs.mkdirSync(PURCHASE_DIR, { recursive: true });

const purchaseStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PURCHASE_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadPurchase = multer({
  storage: purchaseStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload IKM Kasbon proof (gambar + PDF, 10 MB)
// =========================
const IKM_KASBON_DIR = path.join(BASE_DIR, "kasbon");
if (!fs.existsSync(IKM_KASBON_DIR)) fs.mkdirSync(IKM_KASBON_DIR, { recursive: true });

const ikmKasbonStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IKM_KASBON_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadIKMKasbon = multer({
  storage: ikmKasbonStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// =========================
// Upload Document Alora (gambar + PDF, 10 MB)
// =========================
const DOC_ALORA_DIR = path.join(BASE_DIR, "document_alora");
if (!fs.existsSync(DOC_ALORA_DIR)) fs.mkdirSync(DOC_ALORA_DIR, { recursive: true });

const docAloraStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOC_ALORA_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 60);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

export const uploadDocAlora = multer({
  storage: docAloraStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});