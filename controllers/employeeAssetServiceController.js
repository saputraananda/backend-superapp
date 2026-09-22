import { safeQuery } from "../db/pool.js";
import fs from "fs";
import path from "path";
import { AVATAR_DIR, DOCUMENT_DIR } from "../middleware/upload.js";

/**
 * Upload foto profil & dokumen karyawan dari aplikasi lain (Waschen Mobile).
 * File mendarat di storage/assets/{avatars,documents}, kolom mst_employee
 * diisi persis seperti upload dari Alsa: /assets/avatars/... & /assets/documents/...
 *
 * Autentikasi: header x-service-token (SERVICE_UPLOAD_TOKEN), bukan sesi browser.
 */

const DOC_MAP = {
  ktp: { nameCol: "ktp_name", pathCol: "ktp_path" },
  kk: { nameCol: "kk_name", pathCol: "kk_path" },
  npwp: { nameCol: "npwp_name", pathCol: "npwp_path" },
  bpjs: { nameCol: "bpjs_name", pathCol: "bpjs_path" },
  bpjs_tk: { nameCol: "bpjs_tk_name", pathCol: "bpjs_tk_path" },
  ijazah: { nameCol: "ijazah_name", pathCol: "ijazah_path" },
  sertifikat: { nameCol: "sertifikat_name", pathCol: "sertifikat_path" },
  rekomkerja: { nameCol: "rekomkerja_name", pathCol: "rekomkerja_path" },
  profile: { nameCol: "profile_name", pathCol: "profile_path" },
};

const deleteOldFile = (filePath, dir) => {
  if (!filePath) return;
  const abs = path.join(dir, path.basename(String(filePath)));
  if (fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch (_) {}
  }
};

const removeUploaded = (file) => {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (_) {}
};

/** POST /service/employee-assets/:docType — multipart field "file" */
export const uploadEmployeeAssetService = async (req, res) => {
  const docType = String(req.params.docType || "").toLowerCase();
  const meta = DOC_MAP[docType];

  if (!meta) {
    removeUploaded(req.file);
    return res.status(400).json({ message: "Tipe dokumen tidak valid." });
  }
  if (!req.file) {
    return res.status(400).json({ message: "Tidak ada file yang diupload." });
  }

  const employeeId = Number(req.body?.employee_id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    removeUploaded(req.file);
    return res.status(400).json({ message: "employee_id tidak valid." });
  }

  const isPhoto = docType === "profile";
  const dir = isPhoto ? AVATAR_DIR : DOCUMENT_DIR;
  const publicPath = `/assets/${isPhoto ? "avatars" : "documents"}/${req.file.filename}`;

  try {
    const [rows] = await safeQuery(
      `SELECT ${meta.pathCol} AS old_path, email FROM mst_employee WHERE employee_id = ? AND is_deleted = 0`,
      [employeeId]
    );
    if (rows.length === 0) {
      removeUploaded(req.file);
      return res.status(404).json({ message: "Employee not found" });
    }

    await safeQuery(
      `UPDATE mst_employee SET ${meta.nameCol} = ?, ${meta.pathCol} = ? WHERE employee_id = ? AND is_deleted = 0`,
      [req.file.originalname, publicPath, employeeId]
    );

    // Samakan dengan uploadProfilePhoto di Alsa: avatar users ikut diperbarui
    if (isPhoto && rows[0].email) {
      await safeQuery("UPDATE users SET avatar = ? WHERE email = ?", [publicPath, rows[0].email]);
    }

    deleteOldFile(rows[0].old_path, dir);

    return res.json({
      message: "Berhasil diupload.",
      [`${docType}_name`]: req.file.originalname,
      [`${docType}_path`]: publicPath,
    });
  } catch (error) {
    removeUploaded(req.file);
    console.error("uploadEmployeeAssetService error:", error);
    return res.status(500).json({ message: "Gagal menyimpan file." });
  }
};
