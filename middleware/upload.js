import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Folder: backend/assets/evidence/
const UPLOAD_DIR   = path.join(__dirname, "..", "assets", "evidence");

// Folder: backend/assets/avatars/
const AVATAR_DIR   = path.join(__dirname, "..", "assets", "avatars");

// Folder: backend/assets/documents/
const DOCUMENT_DIR = path.join(__dirname, "..", "assets", "documents");

// Buat folder kalau belum ada
[UPLOAD_DIR, AVATAR_DIR, DOCUMENT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Storage untuk evidence
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 80);
    const unique   = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

// Storage untuk avatar & KTP (hanya gambar)
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext    = path.extname(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}${ext}`);
  },
});

// Storage untuk dokumen (PDF + gambar)
const documentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCUMENT_DIR),
  filename: (_req, file, cb) => {
    const ext    = path.extname(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}${ext}`);
  },
});

// Filter: hanya gambar
const imageFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ext     = path.extname(file.originalname).toLowerCase();
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Hanya file gambar (jpg, png, webp) yang diizinkan."));
  }
};

// Filter: gambar + PDF
const documentFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp|pdf/;
  const ext     = path.extname(file.originalname).toLowerCase();
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Hanya file JPG, PNG, WEBP, atau PDF yang diizinkan."));
  }
};

// Filter: semua file (evidence)
const fileFilter = (_req, file, cb) => {
  cb(null, true);
};

// Upload evidence (semua tipe, 20 MB)
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Upload avatar & KTP (hanya gambar, 5 MB)
export const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Upload dokumen (gambar + PDF, 10 MB)
export const uploadDocument = multer({
  storage: documentStorage,
  fileFilter: documentFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});