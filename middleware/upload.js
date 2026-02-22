import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Folder: backend/assets/evidence/
const UPLOAD_DIR = path.join(__dirname, "..", "assets", "evidence");

// Folder: backend/assets/avatars/
const AVATAR_DIR = path.join(__dirname, "..", "assets", "avatars");

// Buat folder kalau belum ada
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext       = path.extname(file.originalname);
    const baseName  = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, "_")
      .slice(0, 80);
    const unique    = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${baseName}_${unique}${ext}`);
  },
});

// Storage khusus untuk avatar & KTP
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const unique   = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${unique}${ext}`);
  },
});

const imageFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const ext     = path.extname(file.originalname).toLowerCase();
  if (allowed.test(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Hanya file gambar (jpg, png, webp) yang diizinkan."));
  }
};

const fileFilter = (_req, file, cb) => {
  cb(null, true);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
});

export const uploadAvatar = multer({
  storage: avatarStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});