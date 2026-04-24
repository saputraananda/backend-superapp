import { safeQuery } from "../db/pool.js";
import fs from "fs";
import path from "path";

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(process.cwd(), "assets");

const WASCHEN_COMPANY_ID = 5;

const CHEMICAL_SCORE_MAP = {
  Aman: 4,
  Setengah: 3,
  Sedikit: 2,
  Habis: 1,
};

const DEFAULT_CHEMICAL_OPTIONS = [
  "Obat Tinta (Ink)",
  "Obat Karat (Rust)",
  "Yellow Go",
  "Colorsol",
  "Obat kunyit",
  "Obat Darah",
  "Metanol",
  "Bon Go (kunyit)",
];

function parseJsonArray(input) {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string" || !input.trim()) return [];

  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMaybeJson(input, fallback) {
  if (input == null) return fallback;
  if (typeof input === "object") return input;
  if (typeof input !== "string" || !input.trim()) return fallback;

  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

function normalizeChemicalItems(input) {
  const items = parseJsonArray(input)
    .map((item) => {
      const name = String(item?.name || "").trim();
      const status = String(item?.status || "Aman").trim();
      const score = Number(item?.score || CHEMICAL_SCORE_MAP[status] || 0);

      if (!name) return null;
      if (!CHEMICAL_SCORE_MAP[status]) return null;

      return {
        name,
        status,
        score,
      };
    })
    .filter(Boolean);

  return items;
}

function removeAssetFile(relativePath) {
  if (!relativePath) return;
  const cleaned = String(relativePath).replace(/^\/+/, "");
  const fullPath = path.join(ASSETS_BASE, cleaned);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch (_err) {
      // Ignore delete errors to avoid blocking API
    }
  }
}

export const getCompanies = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      `SELECT company_id, company_code, company_name
       FROM mst_company
       WHERE is_active = 1
       ORDER BY company_name ASC`,
      []
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getOutlets = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      "SELECT id, name, full_name FROM mst_outlet ORDER BY name ASC",
      []
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getChemicalLeaderMeta = async (_req, res) => {
  try {
    const [leaders] = await safeQuery(
      `SELECT employee_id, full_name
       FROM mst_employee
       WHERE company_id = 1
         AND is_deleted = 0
       ORDER BY full_name ASC`,
      []
    );

    const [outlets] = await safeQuery(
      "SELECT id, name, full_name FROM mst_outlet ORDER BY name ASC",
      []
    );

    res.json({
      company_id: WASCHEN_COMPANY_ID,
      leaders,
      outlets,
      chemicalOptions: DEFAULT_CHEMICAL_OPTIONS,
      scoreOptions: Object.keys(CHEMICAL_SCORE_MAP).map((label) => ({
        label,
        score: CHEMICAL_SCORE_MAP[label],
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createChemicalLeaderReport = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const visitDate = String(req.body.visit_date || "").trim();
    const outletId = Number(req.body.outlet_id || 0);
    const leaderIds = parseJsonArray(req.body.leader_employee_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const chemicalItems = normalizeChemicalItems(req.body.chemicals);
    const outletIssue = String(req.body.outlet_issue || "").trim();
    const suggestionImprovement = String(req.body.suggestion_improvement || "").trim();

    if (!visitDate) {
      return res.status(400).json({ message: "Tanggal kunjungan wajib diisi." });
    }
    if (!outletId) {
      return res.status(400).json({ message: "Cabang atau outlet wajib dipilih." });
    }
    if (leaderIds.length === 0) {
      return res.status(400).json({ message: "Nama Leader Operasional wajib dipilih." });
    }
    if (chemicalItems.length === 0) {
      return res.status(400).json({ message: "Data chemical wajib diisi minimal 1 item." });
    }

    const [outletRows] = await safeQuery(
      "SELECT id, name, full_name FROM mst_outlet WHERE id = ? LIMIT 1",
      [outletId]
    );
    if (outletRows.length === 0) {
      return res.status(400).json({ message: "Outlet tidak valid." });
    }

    const placeholders = leaderIds.map(() => "?").join(",");
    const [leaderRows] = await safeQuery(
      `SELECT employee_id, full_name
       FROM mst_employee
       WHERE employee_id IN (${placeholders})
         AND company_id = 1
         AND is_deleted = 0
       ORDER BY full_name ASC`,
      leaderIds
    );

    if (leaderRows.length !== leaderIds.length) {
      return res.status(400).json({
        message: "Nama Leader Operasional tidak valid atau tidak termasuk company management (company_id = 1).",
      });
    }

    const photoPaths = (req.files || []).map((file) => `buktiLO/${file.filename}`);
    const totalScore = chemicalItems.reduce((sum, item) => sum + Number(item.score || 0), 0);
    const avgScore = chemicalItems.length > 0 ? totalScore / chemicalItems.length : 0;

    const [insertResult] = await safeQuery(
      `INSERT INTO tr_report_leader_waschen (
        company_id,
        visit_date,
        outlet_id,
        outlet_name,
        leader_employee_ids_json,
        leader_names_json,
        chemical_items_json,
        total_score,
        avg_score,
        outlet_issue,
        suggestion_improvement,
        photo_paths_json,
        created_by_user_id,
        created_by_employee_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        WASCHEN_COMPANY_ID,
        visitDate,
        outletRows[0].id,
        outletRows[0].full_name || outletRows[0].name,
        JSON.stringify(leaderRows.map((row) => row.employee_id)),
        JSON.stringify(leaderRows.map((row) => row.full_name)),
        JSON.stringify(chemicalItems),
        totalScore,
        Number(avgScore.toFixed(2)),
        outletIssue || null,
        suggestionImprovement || null,
        JSON.stringify(photoPaths),
        Number(userId),
        req.session?.employeeId ? Number(req.session.employeeId) : null,
      ]
    );

    res.status(201).json({
      message: "Laporan Chemical Leader Operasional berhasil disimpan.",
      report_id: insertResult.insertId,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const getChemicalLeaderReports = async (req, res) => {
  try {
    const params = [];
    const where = ["company_id = ?"];
    params.push(WASCHEN_COMPANY_ID);

    if (req.query.outlet_id) {
      where.push("outlet_id = ?");
      params.push(Number(req.query.outlet_id));
    }

    if (req.query.start_date) {
      where.push("visit_date >= ?");
      params.push(req.query.start_date);
    }

    if (req.query.end_date) {
      where.push("visit_date <= ?");
      params.push(req.query.end_date);
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);

    const [rows] = await safeQuery(
      `SELECT
        report_id,
        company_id,
        visit_date,
        outlet_id,
        outlet_name,
        leader_employee_ids_json,
        leader_names_json,
        chemical_items_json,
        total_score,
        avg_score,
        outlet_issue,
        suggestion_improvement,
        photo_paths_json,
        created_by_user_id,
        created_by_employee_id,
        created_at,
        updated_at
      FROM tr_report_leader_waschen
       WHERE ${where.join(" AND ")}
       ORDER BY visit_date DESC, report_id DESC
       LIMIT ?`,
      [...params, limit]
    );

    const reports = rows.map((row) => ({
      ...row,
      leader_employee_ids: parseMaybeJson(row.leader_employee_ids_json, []),
      leader_names: parseMaybeJson(row.leader_names_json, []),
      chemical_items: parseMaybeJson(row.chemical_items_json, []),
      photo_paths: parseMaybeJson(row.photo_paths_json, []),
    }));

    res.json({ reports });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateChemicalLeaderReport = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const reportId = Number(req.params.id || 0);
    if (!reportId) return res.status(400).json({ message: "Report ID tidak valid." });

    const [existingRows] = await safeQuery(
      "SELECT report_id, photo_paths_json FROM tr_report_leader_waschen WHERE report_id = ? AND company_id = ?",
      [reportId, WASCHEN_COMPANY_ID]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Report tidak ditemukan." });
    }

    const visitDate = String(req.body.visit_date || "").trim();
    const outletId = Number(req.body.outlet_id || 0);
    const leaderIds = parseJsonArray(req.body.leader_employee_ids)
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const chemicalItems = normalizeChemicalItems(req.body.chemicals);
    const outletIssue = String(req.body.outlet_issue || "").trim();
    const suggestionImprovement = String(req.body.suggestion_improvement || "").trim();
    const deletedPhotoPaths = parseJsonArray(req.body.deleted_photo_paths).map((p) => String(p));

    if (!visitDate) {
      return res.status(400).json({ message: "Tanggal kunjungan wajib diisi." });
    }
    if (!outletId) {
      return res.status(400).json({ message: "Cabang atau outlet wajib dipilih." });
    }
    if (leaderIds.length === 0) {
      return res.status(400).json({ message: "Nama Leader Operasional wajib dipilih." });
    }
    if (chemicalItems.length === 0) {
      return res.status(400).json({ message: "Data chemical wajib diisi minimal 1 item." });
    }

    const [outletRows] = await safeQuery(
      "SELECT id, name, full_name FROM mst_outlet WHERE id = ? LIMIT 1",
      [outletId]
    );
    if (outletRows.length === 0) {
      return res.status(400).json({ message: "Outlet tidak valid." });
    }

    const placeholders = leaderIds.map(() => "?").join(",");
    const [leaderRows] = await safeQuery(
      `SELECT employee_id, full_name
       FROM mst_employee
       WHERE employee_id IN (${placeholders})
         AND company_id = 1
         AND is_deleted = 0
       ORDER BY full_name ASC`,
      leaderIds
    );
    if (leaderRows.length !== leaderIds.length) {
      return res.status(400).json({
        message: "Nama Leader Operasional tidak valid atau tidak termasuk company management (company_id = 1).",
      });
    }

    const existingPhotoPaths = parseMaybeJson(existingRows[0].photo_paths_json, []);
    const keptPhotoPaths = existingPhotoPaths.filter(
      (path) => !deletedPhotoPaths.includes(path)
    );
    deletedPhotoPaths.forEach((path) => removeAssetFile(path));

    const newPhotoPaths = (req.files || []).map((file) => `buktiLO/${file.filename}`);
    const finalPhotoPaths = [...keptPhotoPaths, ...newPhotoPaths];

    const totalScore = chemicalItems.reduce((sum, item) => sum + Number(item.score || 0), 0);
    const avgScore = chemicalItems.length > 0 ? totalScore / chemicalItems.length : 0;

    await safeQuery(
      `UPDATE tr_report_leader_waschen SET
        visit_date = ?,
        outlet_id = ?,
        outlet_name = ?,
        leader_employee_ids_json = ?,
        leader_names_json = ?,
        chemical_items_json = ?,
        total_score = ?,
        avg_score = ?,
        outlet_issue = ?,
        suggestion_improvement = ?,
        photo_paths_json = ?,
        updated_at = NOW()
       WHERE report_id = ? AND company_id = ?`,
      [
        visitDate,
        outletRows[0].id,
        outletRows[0].full_name || outletRows[0].name,
        JSON.stringify(leaderRows.map((row) => row.employee_id)),
        JSON.stringify(leaderRows.map((row) => row.full_name)),
        JSON.stringify(chemicalItems),
        totalScore,
        Number(avgScore.toFixed(2)),
        outletIssue || null,
        suggestionImprovement || null,
        JSON.stringify(finalPhotoPaths),
        reportId,
        WASCHEN_COMPANY_ID,
      ]
    );

    res.json({ message: "Report berhasil diupdate." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteChemicalLeaderReport = async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const reportId = Number(req.params.id || 0);
    if (!reportId) return res.status(400).json({ message: "Report ID tidak valid." });

    const [rows] = await safeQuery(
      "SELECT photo_paths_json FROM tr_report_leader_waschen WHERE report_id = ? AND company_id = ?",
      [reportId, WASCHEN_COMPANY_ID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Report tidak ditemukan." });
    }

    const photoPaths = parseMaybeJson(rows[0].photo_paths_json, []);
    photoPaths.forEach((path) => removeAssetFile(path));

    await safeQuery(
      "DELETE FROM tr_report_leader_waschen WHERE report_id = ? AND company_id = ?",
      [reportId, WASCHEN_COMPANY_ID]
    );

    res.json({ message: "Report berhasil dihapus." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};