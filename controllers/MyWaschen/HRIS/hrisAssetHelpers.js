/** URL builder aset HRIS Waschen Mobile (absensi, perizinan, kasbon) */

function stripTrailingSlash(v) {
  return String(v || "").replace(/\/$/, "");
}

/** Base URL publik untuk file upload Waschen Mobile */
export function getWaschenMobilePublicBase(req) {
  const fromEnv = stripTrailingSlash(process.env.WASCHEN_MOBILE_PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv;
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
