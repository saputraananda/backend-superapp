import path from "path";

/**
 * Satu env: WASCHEN_MOBILE_PUBLIC_BASE_URL
 * - Production (HTTP): https://app.mywaschen.com → build URL foto ke Waschen Mobile
 * - Development (path): C:\...\waschen-mobile\ → root lokal; derive uploads/assets/*
 * - Kosong: URL fallback ke host Alsa (req)
 */

function stripTrailingSep(v) {
  return String(v || "").replace(/[\\/]+$/, "");
}

export function getWaschenMobileEnvRaw() {
  return String(process.env.WASCHEN_MOBILE_PUBLIC_BASE_URL || "").trim();
}

export function isWaschenMobileHttpBase(value = getWaschenMobileEnvRaw()) {
  return /^https?:\/\//i.test(value);
}

export function isWaschenMobileLocalRoot(value = getWaschenMobileEnvRaw()) {
  if (!value || isWaschenMobileHttpBase(value)) return false;
  return true;
}

export function getWaschenMobileLocalRoot() {
  const raw = getWaschenMobileEnvRaw();
  if (!isWaschenMobileLocalRoot(raw)) return null;
  return path.resolve(stripTrailingSep(raw));
}

/** contoh relativeUnderUploadsAssets: "attendance" | "produksi/frontliner" */
export function getWaschenMobileAssetDir(relativeUnderUploadsAssets) {
  const root = getWaschenMobileLocalRoot();
  if (!root) return null;
  const parts = String(relativeUnderUploadsAssets || "")
    .split(/[\\/]/)
    .filter(Boolean);
  return path.join(root, "uploads", "assets", ...parts);
}

export function getWaschenMobileAttendanceDir() {
  return getWaschenMobileAssetDir("attendance");
}

export function getWaschenMobileLeaveDir() {
  return getWaschenMobileAssetDir("leave");
}

export function getWaschenMobileKasbonDir() {
  return getWaschenMobileAssetDir("kasbon");
}

export function getWaschenMobileQcDir(stage) {
  return getWaschenMobileAssetDir(`produksi/${stage}`);
}

/** Base URL publik untuk file upload Waschen Mobile */
export function getWaschenMobilePublicBase(req) {
  const raw = getWaschenMobileEnvRaw();
  if (isWaschenMobileHttpBase(raw)) {
    return stripTrailingSep(raw);
  }
  // Path lokal / kosong → dilayani host Alsa (static mount dari root lokal)
  if (req) return `${req.protocol}://${req.get("host")}`;
  return "";
}

export function buildAttendancePhotoUrl(req, photoPath, photoName) {
  if (!photoPath || !photoName) return null;
  const base = getWaschenMobilePublicBase(req);
  const normalized = photoPath.startsWith("/") ? photoPath : `/${photoPath}`;
  return `${base}${normalized}/${encodeURIComponent(photoName)}`;
}

export function buildLeaveDocUrl(req, docPath, docName) {
  if (!docPath || !docName) return null;
  const base = getWaschenMobilePublicBase(req);
  const normalized = docPath.startsWith("/") ? docPath : `/${docPath}`;
  return `${base}${normalized}/${encodeURIComponent(docName)}`;
}

export function buildKasbonProofUrl(req, proofPath) {
  if (!proofPath) return null;
  const base = getWaschenMobilePublicBase(req);
  const normalized = proofPath.startsWith("/") ? proofPath : `/${proofPath}`;
  return `${base}${normalized}`;
}

/** Foto QC produksi — path DB: /uploads/assets/produksi/{stage}/file.jpg */
export function buildProduksiPhotoUrl(req, photoPath) {
  if (!photoPath) return null;
  const base = getWaschenMobilePublicBase(req);
  const normalized = photoPath.startsWith("/") ? photoPath : `/${photoPath}`;
  return `${base}${normalized}`;
}
