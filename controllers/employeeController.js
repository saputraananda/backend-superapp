import { safeQuery } from "../db/pool.js";
import fs   from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const AVATAR_DIR   = path.join(__dirname, "..", "assets", "avatars");
const DOCUMENT_DIR = path.join(__dirname, "..", "assets", "documents");

const deleteOldFile = (filePath, dir = AVATAR_DIR) => {
  if (!filePath) return;
  const abs = path.join(dir, path.basename(filePath));
  if (fs.existsSync(abs)) {
    try { fs.unlinkSync(abs); } catch (_) {}
  }
};

const DOC_MAP = {
  ktp:        { nameCol: "ktp_name",        pathCol: "ktp_path"        },
  kk:         { nameCol: "kk_name",         pathCol: "kk_path"         },
  npwp:       { nameCol: "npwp_name",       pathCol: "npwp_path"       },
  bpjs:       { nameCol: "bpjs_name",       pathCol: "bpjs_path"       },
  bpjs_tk:    { nameCol: "bpjs_tk_name",    pathCol: "bpjs_tk_path"    },
  ijazah:     { nameCol: "ijazah_name",     pathCol: "ijazah_path"     },
  sertifikat: { nameCol: "sertifikat_name", pathCol: "sertifikat_path" },
  rekomkerja: { nameCol: "rekomkerja_name", pathCol: "rekomkerja_path" },
};

// ── GET PROFILE ────────────────────────────────────────────────────────────
export const getProfile = async (req, res) => {
  if (!req.session.userEmail) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const [rows] = await safeQuery(
      `SELECT e.*, 
        u.username,
        c.company_name, j.job_level_name, p.position_name, d.department_name,
        es.employment_status_name, ed.education_level_name,
        r.religion_name, b.bank_name
       FROM mst_employee e
       LEFT JOIN users                u  ON u.email              = e.email
       LEFT JOIN mst_company          c  ON e.company_id          = c.company_id
       LEFT JOIN mst_job_level        j  ON e.job_level_id        = j.job_level_id
       LEFT JOIN mst_position         p  ON e.position_id         = p.position_id
       LEFT JOIN mst_department       d  ON e.department_id       = d.department_id
       LEFT JOIN mst_employment_status es ON e.employment_status_id = es.employment_status_id
       LEFT JOIN mst_education_level  ed ON e.education_level_id  = ed.education_level_id
       LEFT JOIN mst_religion         r  ON e.religion_id         = r.religion_id
       LEFT JOIN mst_bank             b  ON e.bank_id             = b.bank_id
       WHERE e.email = ? AND e.is_deleted = 0`,
      [req.session.userEmail]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const emp = rows[0];
    if (parseInt(emp.company_id) === 2) {
      emp.documents_base_url = process.env.IKM_DOCUMENTS_BASE_URL || "https://api.ikmalora.com/storage/documents";
      emp.avatars_base_url   = process.env.IKM_AVATARS_BASE_URL   || "https://api.ikmalora.com/storage/avatars";
    } else {
      emp.documents_base_url = null;
      emp.avatars_base_url   = null;
    }

    res.json({ employee: emp });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── UPDATE PROFILE ─────────────────────────────────────────────────────────
export const updateProfile = async (req, res) => {
  if (!req.session.userEmail) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  const toNull = (value) => (value === "" || value == null ? null : value);

  const {
    full_name, gender, birth_place, birth_date, address, ktp_number,
    family_card_number, phone_number, company_id, job_level_id, position_id,
    department_id, join_date, employment_status_id, contract_end_date,
    education_level_id, school_name, major_name, religion_id, marital_status,
    bpjs_health_number, bpjs_employment_number, npwp_number,
    bank_id, bank_account_number, emergency_contact, notes, employee_code,
    username, mother_name, email, private_email,
  } = req.body;

  if (!employee_code?.trim()) {
    return res.status(400).json({ message: "Nomor Induk Karyawan wajib diisi." });
  }

  if (company_id === "" || company_id == null) {
    return res.status(400).json({ message: "Perusahaan wajib diisi." });
  }

  if (job_level_id === "" || job_level_id == null) {
    return res.status(400).json({ message: "Jabatan wajib diisi." });
  }

  // Validasi format nomor telepon: wajib 08xxxxxxx (9–13 digit total)
  if (phone_number && !/^08[0-9]{7,11}$/.test(phone_number)) {
    return res.status(400).json({ message: "Format nomor telepon tidak valid. Gunakan format 08xxxxxxxxxx, contoh: 087770597000" });
  }

  const oldEmail = req.session.userEmail;
  const newEmail = email?.trim() || oldEmail;

  try {
    const [existing] = await safeQuery(
      "SELECT employee_id FROM mst_employee WHERE employee_code = ? AND email != ? AND is_deleted = 0",
      [employee_code, oldEmail]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: "Nomor Induk Karyawan sudah digunakan oleh karyawan lain." });
    }

    // Validasi email unik jika berubah
    if (newEmail !== oldEmail) {
      const [existEmail] = await safeQuery(
        "SELECT employee_id FROM mst_employee WHERE email = ? AND is_deleted = 0",
        [newEmail]
      );
      if (existEmail.length > 0) {
        return res.status(400).json({ message: "Email sudah digunakan oleh karyawan lain." });
      }
    }

    // ← Cek username unik jika diisi
    if (username?.trim()) {
      const [existUsername] = await safeQuery(
        "SELECT id FROM users WHERE username = ? AND email != ?",
        [username.trim(), oldEmail]
      );
      if (existUsername.length > 0) {
        return res.status(400).json({ message: "Username sudah digunakan oleh pengguna lain." });
      }
    }

    await safeQuery(
      `UPDATE mst_employee SET
        full_name = ?, gender = ?, birth_place = ?, birth_date = ?,
        address = ?, ktp_number = ?, family_card_number = ?,
        phone_number = ?, company_id = ?, job_level_id = ?, position_id = ?,
        department_id = ?, join_date = ?, employment_status_id = ?,
        contract_end_date = ?, education_level_id = ?, school_name = ?, major_name = ?,
        religion_id = ?, marital_status = ?, bpjs_health_number = ?,
        bpjs_employment_number = ?, npwp_number = ?, bank_id = ?,
        bank_account_number = ?, emergency_contact = ?, notes = ?, employee_code = ?,
        mother_name = ?, email = ?, private_email = ?
       WHERE email = ? AND is_deleted = 0`,
      [
        full_name, gender, birth_place, toNull(birth_date), address, ktp_number,
        family_card_number, phone_number, toNull(company_id), toNull(job_level_id), toNull(position_id),
        toNull(department_id), toNull(join_date), toNull(employment_status_id), toNull(contract_end_date),
        toNull(education_level_id), school_name, major_name || null, toNull(religion_id), marital_status,
        bpjs_health_number, bpjs_employment_number, npwp_number,
        toNull(bank_id), bank_account_number, emergency_contact, notes,
        employee_code, mother_name || null, newEmail, private_email || null, oldEmail,
      ]
    );

    // Sinkronisasi tabel users
    const userUpdates = [];
    const userParams = [];

    if (typeof full_name === "string" && full_name.trim() !== "") {
      userUpdates.push("name = ?");
      userParams.push(full_name);
    }
    if (typeof username === "string") {
      userUpdates.push("username = ?");
      userParams.push(username.trim() || null);
    }
    if (newEmail !== oldEmail) {
      userUpdates.push("email = ?");
      userParams.push(newEmail);
    }

    if (userUpdates.length > 0) {
      userParams.push(oldEmail);
      await safeQuery(
        `UPDATE users SET ${userUpdates.join(", ")} WHERE email = ?`,
        userParams
      );
    }

    // Update session jika email atau username berubah
    if (newEmail !== oldEmail) req.session.userEmail = newEmail;
    if (typeof username === "string") req.session.userName = username.trim() || null;

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update profile error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── UPLOAD PAS FOTO ────────────────────────────────────────────────────────
export const uploadProfilePhoto = async (req, res) => {
  if (!req.session.userEmail) return res.status(401).json({ message: "Not authenticated" });
  if (!req.file)              return res.status(400).json({ message: "Tidak ada file yang diupload." });

  try {
    const [rows] = await safeQuery(
      "SELECT profile_path FROM mst_employee WHERE email = ? AND is_deleted = 0",
      [req.session.userEmail]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    deleteOldFile(rows[0].profile_path, AVATAR_DIR);

    const filePath = `/assets/avatars/${req.file.filename}`;

    await safeQuery(
      "UPDATE mst_employee SET profile_name = ?, profile_path = ? WHERE email = ? AND is_deleted = 0",
      [req.file.originalname, filePath, req.session.userEmail]
    );
    await safeQuery(
      "UPDATE users SET avatar = ? WHERE email = ?",
      [filePath, req.session.userEmail]
    );

    res.json({
      message:      "Foto profil berhasil diupload.",
      profile_name: req.file.originalname,
      profile_path: filePath,
    });
  } catch (error) {
    console.error("Upload profile photo error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── DELETE PAS FOTO ────────────────────────────────────────────────────────
export const deleteProfilePhoto = async (req, res) => {
  if (!req.session.userEmail) return res.status(401).json({ message: "Not authenticated" });

  try {
    const [rows] = await safeQuery(
      "SELECT profile_path FROM mst_employee WHERE email = ? AND is_deleted = 0",
      [req.session.userEmail]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    deleteOldFile(rows[0].profile_path, AVATAR_DIR);

    await safeQuery(
      "UPDATE mst_employee SET profile_name = NULL, profile_path = NULL WHERE email = ? AND is_deleted = 0",
      [req.session.userEmail]
    );
    await safeQuery("UPDATE users SET avatar = NULL WHERE email = ?", [req.session.userEmail]);

    res.json({ message: "Foto profil berhasil dihapus." });
  } catch (error) {
    console.error("Delete profile photo error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── UPLOAD DOKUMEN ─────────────────────────────────────────────────────────
export const uploadDoc = async (req, res) => {
  const { docType } = req.params;

  if (!req.session.userEmail) return res.status(401).json({ message: "Not authenticated" });

  const docMeta = DOC_MAP[docType];
  if (!docMeta) return res.status(400).json({ message: "Tipe dokumen tidak valid." });
  if (!req.file) return res.status(400).json({ message: "Tidak ada file yang diupload." });

  try {
    const [rows] = await safeQuery(
      `SELECT ${docMeta.pathCol} FROM mst_employee WHERE email = ? AND is_deleted = 0`,
      [req.session.userEmail]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    deleteOldFile(rows[0][docMeta.pathCol], DOCUMENT_DIR);

    const filePath = `/assets/documents/${req.file.filename}`;

    await safeQuery(
      `UPDATE mst_employee SET ${docMeta.nameCol} = ?, ${docMeta.pathCol} = ? WHERE email = ? AND is_deleted = 0`,
      [req.file.originalname, filePath, req.session.userEmail]
    );

    res.json({
      message: "Dokumen berhasil diupload.",
      [`${docType}_name`]: req.file.originalname,
      [`${docType}_path`]: filePath,
    });
  } catch (error) {
    console.error("Upload document error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── DELETE DOKUMEN ─────────────────────────────────────────────────────────
export const deleteDoc = async (req, res) => {
  const { docType } = req.params;

  if (!req.session.userEmail) return res.status(401).json({ message: "Not authenticated" });

  const docMeta = DOC_MAP[docType];
  if (!docMeta) return res.status(400).json({ message: "Tipe dokumen tidak valid." });

  try {
    const [rows] = await safeQuery(
      `SELECT ${docMeta.pathCol} FROM mst_employee WHERE email = ? AND is_deleted = 0`,
      [req.session.userEmail]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Employee not found" });

    deleteOldFile(rows[0][docMeta.pathCol], DOCUMENT_DIR);

    await safeQuery(
      `UPDATE mst_employee SET ${docMeta.nameCol} = NULL, ${docMeta.pathCol} = NULL WHERE email = ? AND is_deleted = 0`,
      [req.session.userEmail]
    );

    res.json({ message: "Dokumen berhasil dihapus." });
  } catch (error) {
    console.error("Delete document error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── GET MASTER DATA ────────────────────────────────────────────────────────
export const getMasterData = async (req, res) => {
  try {
    const [companies]          = await safeQuery("SELECT company_id, company_name, company_code FROM mst_company WHERE is_active = 1");
    const [departments]        = await safeQuery("SELECT department_id, department_name, company_code FROM mst_department WHERE is_active = 1");
    const [positions]          = await safeQuery("SELECT position_id, position_name, company_code FROM mst_position WHERE is_active = 1");
    const [jobLevels]          = await safeQuery("SELECT job_level_id, job_level_name, company_code FROM mst_job_level WHERE is_active = 1");
    const [employmentStatuses] = await safeQuery("SELECT * FROM mst_employment_status WHERE is_active = 1");
    const [educationLevels]    = await safeQuery("SELECT * FROM mst_education_level WHERE is_active = 1");
    const [religions]          = await safeQuery("SELECT * FROM mst_religion WHERE is_active = 1");
    const [banks]              = await safeQuery("SELECT * FROM mst_bank WHERE is_active = 1");

    res.json({ companies, departments, positions, jobLevels, employmentStatuses, educationLevels, religions, banks });
  } catch (error) {
    console.error("Get master data error:", error);
    res.status(500).json({ message: error.message });
  }
};

// ── LIST EMPLOYEES ─────────────────────────────────────────────────────────
export const listEmployees = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT 
        e.employee_id, e.full_name, e.email,
        e.position_id, e.department_id,
        p.position_name  AS position,
        d.department_name AS department
       FROM mst_employee e
       LEFT JOIN mst_position   p ON e.position_id   = p.position_id
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE e.is_deleted = 0
       ORDER BY e.full_name ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error("List employees error:", error);
    res.status(500).json({ message: error.message });
  }
};