// ════════════════════════════════════════════════════════════════════════════
// PURCHASE REQUEST (Pengajuan Barang & Reimburse)
//
// Status code:
//   1 = Telah Diajukan
//   2 = Disetujui Supervisor
//   3 = Disetujui Direktur (default mengetahui BOD)
//   4 = Disetujui GA / PR Ready
//   5 = Disetujui SPV Finance / Menunggu Pembayaran
//   6 = Terbayar (Paid) — staff finance upload bukti bayar
//   7 = Selesai — karyawan upload invoice
//   9 = Ditolak
//
// Flow approval:
//   - Staff create          -> status = 1
//   - Supervisor approve    -> status = 2
//   - Direktur approve      -> status = 3 (default auto)
//   - GA approve            -> status = 4
//   - SPV Finance approve   -> status = 5 (Menunggu Pembayaran)
//   - Staff Finance bayar   -> status = 6 (Paid/Terbayar)
//   - Karyawan upload inv   -> status = 7 (Selesai)
//   - Reject (any auth)     -> status = 9
//
// MULTI-INSTALLMENT PAYMENT (cicilan) — KREDIT:
//   - Pembayaran kredit dapat dilakukan beberapa kali (cicilan) sampai lunas.
//   - Setiap cicilan disimpan di tr_purchase_request_payment.
//   - Total dibayar = SUM(nominal_bayar) di tabel payment.
//   - Sisa = tr_purchase_request.nominal_bayar (target) - total dibayar.
//   - Status tetap = 6 selama sisa > 0 (frontend menampilkan "Belum Lunas" /
//     "Belum Terbayar"). Pembayaran cash juga tercatat 1 baris (lunas sekali bayar).
//
// Aturan edit/hapus oleh pengaju: hanya saat status IN (1, 2, 9)
// ════════════════════════════════════════════════════════════════════════════

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const ASSETS_BASE = isProd
    ? (process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/")
    : path.join(__dirname, "..", "assets");

// ── helpers ─────────────────────────────────────────────────────────────────
const safeQuery = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

const getEmployeeId = (req) =>
    req.session?.employeeId ?? req.session?.employee_id ?? null;

const sanitize = (str) => {
    if (str == null) return null;
    // strip script tags & inline html-ish tag delimiters to prevent injection in stored content
    return String(str)
        .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
        .replace(/<[^>]*>/g, "")
        .trim();
};

// Title Case — setiap kata diawali huruf kapital (digunakan untuk nama_barang, atas_nama, dll.)
const titleCase = (str) => {
    if (str == null) return null;
    return String(str)
        .toLowerCase()
        .replace(/(?:^|\s+)\S/g, (c) => c.toUpperCase())
        .trim();
};

const generatePrCode = async () => {
    const ym = new Date();
    const prefix = `PR-${ym.getFullYear()}${String(ym.getMonth() + 1).padStart(2, "0")}-`;
    const rows = await safeQuery(
        `SELECT pr_code FROM tr_purchase_request
         WHERE pr_code LIKE ? ORDER BY pr_id DESC LIMIT 1`,
        [`${prefix}%`]
    );
    let seq = 1;
    if (rows.length > 0) {
        const last = rows[0].pr_code.split("-").pop();
        seq = (parseInt(last, 10) || 0) + 1;
    }
    return `${prefix}${String(seq).padStart(4, "0")}`;
};

const fetchEmployee = async (employeeId) => {
    const rows = await safeQuery(
        `SELECT e.employee_id, e.full_name, e.department_id, e.job_level_id,
                e.company_id, e.bank_id, e.bank_account_number,
                d.department_name, b.bank_name, c.company_name,
                p.position_name
         FROM mst_employee e
         LEFT JOIN mst_department d ON d.department_id = e.department_id
         LEFT JOIN mst_bank       b ON b.bank_id       = e.bank_id
         LEFT JOIN mst_company    c ON c.company_id    = e.company_id
         LEFT JOIN mst_position   p ON p.position_id   = e.position_id
         WHERE e.employee_id = ? AND e.is_deleted = 0
         LIMIT 1`,
        [employeeId]
    );
    return rows[0] || null;
};

// Finance / GA position names yang mendapat akses all-list & GA-approval
const GA_FINANCE_POSITIONS = [
    "General Affair",
    "Finance, Accounting & Tax",
    "Finance, Accountiing & Tax", // typo variant dari DB
];

const isGAFinance = (positionName) => {
    if (!positionName) return false;
    const pos = String(positionName).toLowerCase();
    return (
        pos.includes("general affair") ||
        pos.includes("finance") ||
        pos.includes("accounting") ||
        pos.includes("accountiing")
    );
};

const isGA = (positionName) => {
    if (!positionName) return false;
    return String(positionName).toLowerCase().includes("general affair");
};

const isFinance = (positionName) => {
    if (!positionName) return false;
    const pos = String(positionName).toLowerCase();
    return pos.includes("finance") || pos.includes("accounting") || pos.includes("accountiing");
};

const writeLog = async (prId, action, employeeId, name, note = null) => {
    await safeQuery(
        `INSERT INTO tr_purchase_request_log (pr_id, action, by_employee_id, by_name, note)
         VALUES (?, ?, ?, ?, ?)`,
        [prId, action, employeeId || null, name || null, note]
    );
};

// ════════════════════════════════════════════════════════════════════════════
// MASTER ENDPOINTS (untuk dropdown form)
// ════════════════════════════════════════════════════════════════════════════
export const getSatuan = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT satuan_id, satuan_name FROM mst_satuan WHERE is_active = 1 ORDER BY satuan_name`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getSatuan]", err);
        res.status(500).json({ message: "Gagal memuat satuan" });
    }
};

export const getCompanies = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT company_id, company_code, company_name FROM mst_company
             WHERE is_active = 1 ORDER BY company_name`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getCompanies]", err);
        res.status(500).json({ message: "Gagal memuat company" });
    }
};

export const getOutlets = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT id AS outlet_id, name, full_name FROM mst_outlet ORDER BY name`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getOutlets]", err);
        res.status(500).json({ message: "Gagal memuat outlet" });
    }
};

export const getVendors = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT id AS vendor_id, nama_vendor, kategori FROM mst_vendor WHERE status = 'AKTIF' ORDER BY nama_vendor`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getVendors]", err);
        res.status(500).json({ message: "Gagal memuat vendor" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// PERIODS — daftar periode cutoff yang tersedia (untuk dropdown filter)
//
// Aturan cutoff: 26 bulan sebelumnya s/d 25 bulan berjalan
// Trik SQL: DATE_SUB(tanggal, 25 hari) → hari 26+ masuk bulan berikutnya,
//           hari 1–25 tetap di bulan yang sama.
//
// scope query param:
//   "me"       → data milik employee sendiri
//   "approval" → data yang bisa di-approve user (berdasar job level)
//   "department" (default) → seluruh departemen employee
// ════════════════════════════════════════════════════════════════════════════
export const getPeriods = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        const scope      = req.query.scope || "department";
        const deptId     = me.department_id;
        const jobLevel   = Number(me.job_level_id);

        let condition;
        const params = [];

        if (scope === "me") {
            condition = "pr.employee_id = ?";
            params.push(employeeId);
        } else if (scope === "all") {
            // Semua pengajuan tanpa batasan departemen (untuk Finance/GA)
            condition = "1 = 1";
        } else if (scope === "approval") {
            if (jobLevel === 3) {
                condition = "pr.department_id = ?";
                params.push(deptId);
            } else {
                condition = "1 = 1"; // Manager / Direktur lihat semua
            }
        } else {
            // department (default)
            // Finance/GA bisa override target departemen via ?department_id=
            // Nilai "all" = semua departemen tanpa filter
            const requestedDeptIdRaw = req.query.department_id;
            const isFinanceGA = isGAFinance(me.position_name);

            if (requestedDeptIdRaw === "all" && isFinanceGA) {
                condition = "1 = 1";
            } else {
                const requestedDeptId = (requestedDeptIdRaw && requestedDeptIdRaw !== "all")
                    ? Number(requestedDeptIdRaw)
                    : null;
                const targetDeptId = (requestedDeptId && isFinanceGA)
                    ? requestedDeptId
                    : deptId;

                if (targetDeptId) {
                    condition = "pr.department_id = ?";
                    params.push(targetDeptId);
                } else {
                    condition = "pr.employee_id = ?";
                    params.push(employeeId);
                }
            }
        }

        const rows = await safeQuery(
            `SELECT DISTINCT
                YEAR(CASE WHEN DAY(pr.tanggal_pengajuan) >= 26
                          THEN pr.tanggal_pengajuan + INTERVAL 1 MONTH
                          ELSE pr.tanggal_pengajuan END) AS year,
                MONTH(CASE WHEN DAY(pr.tanggal_pengajuan) >= 26
                           THEN pr.tanggal_pengajuan + INTERVAL 1 MONTH
                           ELSE pr.tanggal_pengajuan END) AS month
             FROM tr_purchase_request pr
             WHERE pr.is_deleted = 0 AND ${condition}
             ORDER BY year DESC, month DESC`,
            params
        );

        res.json({ periods: rows });
    } catch (err) {
        console.error("[getPeriods]", err);
        res.status(500).json({ message: "Gagal memuat periode" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// DEPARTMENTS — list semua departemen (untuk dropdown filter Finance/GA)
// ════════════════════════════════════════════════════════════════════════════
export const getDepartments = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT department_id, department_name FROM mst_department
             WHERE is_active = 1 ORDER BY department_name`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getDepartments]", err);
        res.status(500).json({ message: "Gagal memuat departemen" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD (riwayat pengajuan satu departemen)
//
// Untuk Finance / GA: dapat memberi query param ?department_id=<id>
// untuk memonitor departemen lain. Nilai khusus "all" = semua departemen
// (tanpa filter). Jika tidak diisi, default ke departemen pengguna sendiri
// (sama seperti karyawan biasa).
// ════════════════════════════════════════════════════════════════════════════
export const getDashboard = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        // Override departmen utk Finance/GA
        const requestedDeptIdRaw = req.query.department_id;
        let departmentId = me.department_id;
        let departmentName = me.department_name;
        let showAll = false;

        if (requestedDeptIdRaw === "all") {
            if (!isGAFinance(me.position_name)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor semua departemen" });
            }
            showAll = true;
            departmentId = null;
            departmentName = "Semua Departemen";
        } else if (requestedDeptIdRaw && Number(requestedDeptIdRaw) !== me.department_id) {
            // Pastikan boleh override
            if (!isGAFinance(me.position_name)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor departemen lain" });
            }
            // Validasi & ambil nama
            const dRows = await safeQuery(
                `SELECT department_id, department_name FROM mst_department WHERE department_id = ?`,
                [Number(requestedDeptIdRaw)]
            );
            if (dRows.length) {
                departmentId   = dRows[0].department_id;
                departmentName = dRows[0].department_name;
            }
        }

        let dptCondition;
        const dptCondParams = [];
        if (showAll) {
            dptCondition = "1 = 1";
        } else if (departmentId) {
            dptCondition = "pr.department_id = ?";
            dptCondParams.push(departmentId);
        } else {
            dptCondition = "pr.employee_id = ?";
            dptCondParams.push(employeeId);
        }

        // ── filter tanggal opsional (cutoff period dari frontend) ──────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        const dateClause = dateFrom && dateTo
            ? " AND pr.tanggal_pengajuan >= ? AND pr.tanggal_pengajuan <= ?"
            : "";
        const dateParams = dateFrom && dateTo ? [dateFrom, dateTo] : [];

        // ── statistik per status, di-departemen yang sama ──────────────────
        const statRows = await safeQuery(
            `SELECT type, status, COUNT(*) AS count, COALESCE(SUM(estimasi_harga), 0) AS total_nominal
             FROM tr_purchase_request pr
             WHERE pr.is_deleted = 0 AND ${dptCondition}${dateClause}
             GROUP BY type, status`,
            [...dptCondParams, ...dateParams]
        );

        const summary = {
            pengajuan: { total: 0, byStatus: {}, totalNominal: 0 },
            reimburse: { total: 0, byStatus: {}, totalNominal: 0 },
        };
        for (const r of statRows) {
            const bucket = summary[r.type] || (summary[r.type] = { total: 0, byStatus: {}, totalNominal: 0 });
            bucket.total += Number(r.count);
            bucket.byStatus[r.status] = Number(r.count);
            bucket.totalNominal += Number(r.total_nominal);
        }

        // ── recent 8 ──────────────────────────────────────────────────────
        const recent = await safeQuery(
            `SELECT pr.pr_id, pr.pr_code, pr.type, pr.nama_barang, pr.qty,
                    pr.estimasi_harga, pr.status, pr.tanggal_pengajuan, pr.created_at,
                    e.full_name AS pengaju_name,
                    d.department_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             WHERE pr.is_deleted = 0 AND ${dptCondition}${dateClause}
             ORDER BY pr.created_at DESC
             LIMIT 8`,
            [...dptCondParams, ...dateParams]
        );

        res.json({
            department: { id: departmentId, name: departmentName },
            summary,
            recent,
        });
    } catch (err) {
        console.error("[getDashboard]", err);
        res.status(500).json({ message: "Gagal memuat dashboard" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST (riwayat pengajuan diri sendiri)
// ════════════════════════════════════════════════════════════════════════════
export const listMy = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const page   = Math.max(1, parseInt(req.query.page) || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 20);
        const offset = (page - 1) * limit;
        const search = req.query.search?.trim() || "";
        const status = req.query.status ? Number(req.query.status) : null;
        const type   = req.query.type?.trim() || "";

        const conditions = ["pr.is_deleted = 0", "pr.employee_id = ?"];
        const params = [employeeId];

        if (search) { conditions.push("(pr.nama_barang LIKE ? OR pr.pr_code LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
        if (status) { conditions.push("pr.status = ?"); params.push(status); }
        if (type)   { conditions.push("pr.type = ?");   params.push(type); }

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const countRows = await safeQuery(
            `SELECT COUNT(*) AS total FROM tr_purchase_request pr ${where}`,
            params
        );
        const total = Number(countRows[0].total);

        const data = await safeQuery(
            `SELECT pr.*, s.satuan_name, c.company_name, o.full_name AS outlet_name,
                    COALESCE((SELECT SUM(p.nominal_bayar)
                              FROM tr_purchase_request_payment p
                              WHERE p.pr_id = pr.pr_id), 0) AS total_paid
             FROM tr_purchase_request pr
             LEFT JOIN mst_satuan  s ON s.satuan_id  = pr.satuan_id
             LEFT JOIN mst_company c ON c.company_id = pr.company_id
             LEFT JOIN mst_outlet  o ON o.id         = pr.outlet_id
             ${where}
             ORDER BY pr.created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({ data, total, page, limit });
    } catch (err) {
        console.error("[listMy]", err);
        res.status(500).json({ message: "Gagal memuat data pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST se-DEPARTEMEN (semua pengajuan teman sedepartemen, untuk dashboard)
//
// Untuk Finance / GA: bisa override ?department_id=<id> untuk monitoring,
// atau ?department_id=all untuk semua departemen.
// ════════════════════════════════════════════════════════════════════════════
export const listDepartment = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        // Override departmen utk Finance/GA
        const requestedDeptIdRaw = req.query.department_id;
        let departmentId = me.department_id;
        let departmentName = me.department_name;
        let showAll = false;

        if (requestedDeptIdRaw === "all") {
            if (!isGAFinance(me.position_name)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor semua departemen" });
            }
            showAll = true;
            departmentId = null;
            departmentName = "Semua Departemen";
        } else if (requestedDeptIdRaw && Number(requestedDeptIdRaw) !== me.department_id) {
            if (!isGAFinance(me.position_name)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor departemen lain" });
            }
            const dRows = await safeQuery(
                `SELECT department_id, department_name FROM mst_department WHERE department_id = ?`,
                [Number(requestedDeptIdRaw)]
            );
            if (dRows.length) {
                departmentId   = dRows[0].department_id;
                departmentName = dRows[0].department_name;
            }
        }

        const page   = Math.max(1, parseInt(req.query.page) || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 10);
        const offset = (page - 1) * limit;
        const search = req.query.search?.trim() || "";
        const status = req.query.status ? Number(req.query.status) : null;
        const type   = req.query.type?.trim() || "";

        // Jika tidak punya departemen, fallback ke milik sendiri agar tetap konsisten
        const conditions = ["pr.is_deleted = 0"];
        const params = [];
        if (showAll) {
            // tanpa filter departemen — semua pengajuan
        } else if (departmentId) {
            conditions.push("pr.department_id = ?");
            params.push(departmentId);
        } else {
            conditions.push("pr.employee_id = ?");
            params.push(employeeId);
        }

        if (search) {
            conditions.push("(pr.nama_barang LIKE ? OR pr.pr_code LIKE ? OR e.full_name LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (status) { conditions.push("pr.status = ?"); params.push(status); }
        if (type)   { conditions.push("pr.type = ?");   params.push(type); }

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const countRows = await safeQuery(
            `SELECT COUNT(*) AS total
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee e ON e.employee_id = pr.employee_id
             ${where}`,
            params
        );
        const total = Number(countRows[0].total);

        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name,
                    COALESCE((SELECT SUM(p.nominal_bayar)
                              FROM tr_purchase_request_payment p
                              WHERE p.pr_id = pr.pr_id), 0) AS total_paid
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             ${where}
             ORDER BY pr.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({
            data,
            total,
            page,
            limit,
            department: { id: departmentId, name: departmentName },
        });
    } catch (err) {
        console.error("[listDepartment]", err);
        res.status(500).json({ message: "Gagal memuat data departemen" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST untuk Approval (supervisor / direktur)
// ════════════════════════════════════════════════════════════════════════════
export const listApproval = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        const jobLevel = Number(me.job_level_id);
        // 1 = Direktur, 2 = Manager, 3 = Supervisor
        if (![1, 2, 3].includes(jobLevel)) {
            return res.status(403).json({ message: "Akses ditolak" });
        }

        const conditions = ["pr.is_deleted = 0"];
        const params = [];

        if (jobLevel === 3) {
            // Supervisor: lihat hanya departemennya sendiri yang status 1
            conditions.push("pr.department_id = ?", "pr.status = 1");
            params.push(me.department_id);
        } else if (jobLevel === 2) {
            // Manager: status 1 atau 2 (approval lanjutan), departemen tidak dibatasi (manager lintas dept)
            conditions.push("pr.status IN (1, 2)");
        } else {
            // Direktur (1): status 2 (sudah disetujui SPV), butuh approval direktur
            conditions.push("pr.status = 2");
        }

        const where = `WHERE ${conditions.join(" AND ")}`;
        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             ${where}
             ORDER BY pr.created_at ASC`,
            params
        );

        res.json({ data });
    } catch (err) {
        console.error("[listApproval]", err);
        res.status(500).json({ message: "Gagal memuat data approval" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// DETAIL
// ════════════════════════════════════════════════════════════════════════════
export const getDetail = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, e.job_level_id AS pengaju_job_level,
                    d.department_name, s.satuan_name, c.company_name, o.full_name AS outlet_name,
                    bnk.bank_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e   ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d   ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s   ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c   ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o   ON o.id            = pr.outlet_id
             LEFT JOIN mst_bank       bnk ON bnk.bank_id     = pr.bank_id
             WHERE pr.pr_id = ? AND pr.is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });

        const attachments = await safeQuery(
            `SELECT * FROM tr_purchase_request_attachment WHERE pr_id = ? ORDER BY uploaded_at ASC`,
            [id]
        );

        const logs = await safeQuery(
            `SELECT log_id, action, by_employee_id, by_name, note, logged_at
             FROM tr_purchase_request_log WHERE pr_id = ? ORDER BY logged_at ASC`,
            [id]
        );

        res.json({ data: rows[0], attachments, logs });
    } catch (err) {
        console.error("[getDetail]", err);
        res.status(500).json({ message: "Gagal memuat detail" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// CREATE
// ════════════════════════════════════════════════════════════════════════════
export const createPR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        const type             = ["pengajuan", "reimburse"].includes(req.body.type) ? req.body.type : "pengajuan";
        const tanggalPengajuan = req.body.tanggal_pengajuan || new Date().toISOString().split("T")[0];
        const companyId        = req.body.company_id ? Number(req.body.company_id) : null;
        const outletIdRaw      = req.body.outlet_id ? Number(req.body.outlet_id) : null;
        // Outlet hanya disimpan jika company_id == 5 (sesuai spec: derivatif)
        const outletId         = companyId === 5 ? outletIdRaw : null;

        const namaBarang      = sanitize(req.body.nama_barang);
        const deskripsi       = sanitize(req.body.deskripsi);
        const merk            = titleCase(sanitize(req.body.merk));
        const qty             = Number(req.body.qty || 1);
        const satuanId        = req.body.satuan_id ? Number(req.body.satuan_id) : null;
        const estimasiHarga   = req.body.estimasi_harga ? Number(req.body.estimasi_harga) : null;
        const alasanPembelian = sanitize(req.body.alasan_pembelian);

        // Validasi
        if (!namaBarang)      return res.status(400).json({ message: "Nama barang wajib diisi" });
        if (!alasanPembelian) return res.status(400).json({ message: "Alasan pembelian wajib diisi" });
        if (!companyId)       return res.status(400).json({ message: "Kategori (company) wajib dipilih" });
        if (companyId === 5 && !outletIdRaw) {
            return res.status(400).json({ message: "Outlet wajib dipilih untuk kategori ini" });
        }

        // Reimburse-only fields
        let bankId = null, nomorRekening = null, atasNama = null;
        if (type === "reimburse") {
            bankId        = me.bank_id || null;
            nomorRekening = me.bank_account_number || null;
            atasNama      = titleCase(sanitize(req.body.atas_nama));
            if (!atasNama) return res.status(400).json({ message: "Atas Nama wajib diisi" });
        }

        // Link referensi (opsional, diisi karyawan)
        const linkUrl   = req.body.link_url   ? sanitize(req.body.link_url)   : null;
        const linkTitle = req.body.link_title  ? sanitize(req.body.link_title) : null;
        // Jika karyawan mengisi link, set vendor_mode = 'link' secara default
        const vendorMode = linkUrl ? "link" : null;

        const prCode = await generatePrCode();

        // Jika pengaju adalah Supervisor / Manager / Direktur (job_level <= 3),
        // langsung skip approval supervisor → status = 2, approved_spv_by = diri sendiri
        const jobLevel      = Number(me.job_level_id);
        const autoApproveSpv = jobLevel <= 3;
        const initialStatus  = autoApproveSpv ? 2 : 1;

        const insertResult = await safeQuery(
            `INSERT INTO tr_purchase_request
                (pr_code, type, employee_id, department_id, tanggal_pengajuan,
                 company_id, outlet_id,
                 nama_barang, deskripsi, merk, qty, satuan_id, estimasi_harga, alasan_pembelian,
                 bank_id, nomor_rekening, atas_nama,
                 vendor_mode, link_url, link_title,
                 status,
                 approved_spv_by, approved_spv_at)
             VALUES (?, ?, ?, ?, ?,
                     ?, ?,
                     ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?,
                     ?, ?, ?,
                     ?,
                     ?, ${autoApproveSpv ? "NOW()" : "NULL"})`,
            [prCode, type, employeeId, me.department_id, tanggalPengajuan,
             companyId, outletId,
             namaBarang, deskripsi, merk, qty, satuanId, estimasiHarga, alasanPembelian,
             bankId, nomorRekening, atasNama,
             vendorMode, linkUrl, linkTitle,
             initialStatus,
             autoApproveSpv ? employeeId : null]
        );

        const prId = insertResult.insertId;

        // simpan lampiran (multer handler array name = "attachments")
        const files = req.files || [];
        for (const file of files) {
            await safeQuery(
                `INSERT INTO tr_purchase_request_attachment
                    (pr_id, file_path, original_name, mime_type, file_size_kb)
                 VALUES (?, ?, ?, ?, ?)`,
                [prId, `purchase/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
            );
        }

        const typeLabel = type === "reimburse" ? "Reimburse" : "Pengajuan";
        await writeLog(prId, "created", employeeId, me.full_name,
            `${typeLabel} dibuat & diajukan`);

        if (autoApproveSpv) {
            await writeLog(prId, "approved_spv", employeeId, me.full_name,
                "Disetujui supervisor (otomatis — pengaju adalah supervisor)");
        }

        res.status(201).json({ message: "Pengajuan berhasil dibuat", pr_id: prId, pr_code: prCode });
    } catch (err) {
        console.error("[createPR]", err);
        res.status(500).json({ message: "Gagal membuat pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// UPDATE  (hanya pengaju, ketika status IN (1, 2, 9))
// ════════════════════════════════════════════════════════════════════════════
export const updatePR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        const { id } = req.params;

        const existing = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!existing.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const row = existing[0];
        if (row.employee_id !== employeeId) return res.status(403).json({ message: "Tidak diizinkan" });
        if (![1, 2, 9].includes(Number(row.status))) {
            return res.status(400).json({ message: "Pengajuan pada status ini tidak bisa diedit" });
        }

        const type             = ["pengajuan", "reimburse"].includes(req.body.type) ? req.body.type : row.type;
        const tanggalPengajuan = req.body.tanggal_pengajuan || row.tanggal_pengajuan;
        const companyId        = req.body.company_id ? Number(req.body.company_id) : null;
        const outletIdRaw      = req.body.outlet_id ? Number(req.body.outlet_id) : null;
        const outletId         = companyId === 5 ? outletIdRaw : null;

        const namaBarang      = sanitize(req.body.nama_barang);
        const deskripsi       = sanitize(req.body.deskripsi);
        const merk            = titleCase(sanitize(req.body.merk));
        const qty             = Number(req.body.qty || 1);
        const satuanId        = req.body.satuan_id ? Number(req.body.satuan_id) : null;
        const estimasiHarga   = req.body.estimasi_harga ? Number(req.body.estimasi_harga) : null;
        const alasanPembelian = sanitize(req.body.alasan_pembelian);

        if (!namaBarang)      return res.status(400).json({ message: "Nama barang wajib diisi" });
        if (!alasanPembelian) return res.status(400).json({ message: "Alasan pembelian wajib diisi" });
        if (!companyId)       return res.status(400).json({ message: "Kategori (company) wajib dipilih" });
        if (companyId === 5 && !outletIdRaw) {
            return res.status(400).json({ message: "Outlet wajib dipilih untuk kategori ini" });
        }

        let bankId = null, nomorRekening = null, atasNama = null;
        if (type === "reimburse") {
            bankId        = me.bank_id || null;
            nomorRekening = me.bank_account_number || null;
            atasNama      = titleCase(sanitize(req.body.atas_nama));
            if (!atasNama) return res.status(400).json({ message: "Atas Nama wajib diisi" });
        }

        // Link referensi (opsional, diisi karyawan)
        const linkUrl   = req.body.link_url   ? sanitize(req.body.link_url)   : null;
        const linkTitle = req.body.link_title  ? sanitize(req.body.link_title) : null;
        // Jika karyawan mengisi link, set vendor_mode = 'link'; jika dikosongkan, clear vendor_mode
        const vendorMode = linkUrl ? "link" : null;

        // jika sebelumnya rejected, set kembali ke 1 (Telah Diajukan)
        const newStatus = Number(row.status) === 9 ? 1 : row.status;

        await safeQuery(
            `UPDATE tr_purchase_request SET
                type = ?, tanggal_pengajuan = ?, company_id = ?, outlet_id = ?,
                nama_barang = ?, deskripsi = ?, merk = ?, qty = ?, satuan_id = ?,
                estimasi_harga = ?, alasan_pembelian = ?,
                bank_id = ?, nomor_rekening = ?, atas_nama = ?,
                vendor_mode = ?, link_url = ?, link_title = ?,
                status = ?, rejection_reason = NULL, rejected_at = NULL, rejected_by = NULL,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [type, tanggalPengajuan, companyId, outletId,
             namaBarang, deskripsi, merk, qty, satuanId, estimasiHarga, alasanPembelian,
             bankId, nomorRekening, atasNama,
             vendorMode, linkUrl, linkTitle,
             newStatus, id]
        );

        // tambah lampiran baru (yang lama tetap; dihapus lewat endpoint terpisah)
        const files = req.files || [];
        for (const file of files) {
            await safeQuery(
                `INSERT INTO tr_purchase_request_attachment
                    (pr_id, file_path, original_name, mime_type, file_size_kb)
                 VALUES (?, ?, ?, ?, ?)`,
                [id, `purchase/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
            );
        }

        await writeLog(id, "updated", employeeId, me?.full_name, "Pengajuan diperbarui");

        res.json({ message: "Pengajuan berhasil diperbarui" });
    } catch (err) {
        console.error("[updatePR]", err);
        res.status(500).json({ message: "Gagal memperbarui pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// DELETE  (soft delete, hanya pengaju, status IN (1, 2, 9))
// ════════════════════════════════════════════════════════════════════════════
export const deletePR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT employee_id, status FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        if (rows[0].employee_id !== employeeId) return res.status(403).json({ message: "Tidak diizinkan" });
        if (![1, 2, 9].includes(Number(rows[0].status))) {
            return res.status(400).json({ message: "Pengajuan pada status ini tidak bisa dihapus" });
        }

        await safeQuery(`UPDATE tr_purchase_request SET is_deleted = 1, updated_at = NOW() WHERE pr_id = ?`, [id]);
        const me = await fetchEmployee(employeeId);
        await writeLog(id, "deleted", employeeId, me?.full_name, "Pengajuan dihapus");

        res.json({ message: "Pengajuan berhasil dihapus" });
    } catch (err) {
        console.error("[deletePR]", err);
        res.status(500).json({ message: "Gagal menghapus pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// DELETE ATTACHMENT (oleh pengaju, status IN (1, 2, 9))
// ════════════════════════════════════════════════════════════════════════════
export const deleteAttachment = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const { attachmentId } = req.params;
        const att = await safeQuery(
            `SELECT a.*, pr.employee_id, pr.status
             FROM tr_purchase_request_attachment a
             JOIN tr_purchase_request pr ON pr.pr_id = a.pr_id
             WHERE a.attachment_id = ?`,
            [attachmentId]
        );
        if (!att.length) return res.status(404).json({ message: "Lampiran tidak ditemukan" });
        const row = att[0];
        if (row.employee_id !== employeeId) return res.status(403).json({ message: "Tidak diizinkan" });
        if (![1, 2, 9].includes(Number(row.status))) {
            return res.status(400).json({ message: "Tidak bisa menghapus lampiran pada status ini" });
        }

        // hapus file fisik
        try {
            const full = path.join(ASSETS_BASE, row.file_path);
            if (fs.existsSync(full)) fs.unlinkSync(full);
        } catch (e) {
            console.warn("[deleteAttachment] fs unlink:", e.message);
        }

        await safeQuery(`DELETE FROM tr_purchase_request_attachment WHERE attachment_id = ?`, [attachmentId]);
        res.json({ message: "Lampiran dihapus" });
    } catch (err) {
        console.error("[deleteAttachment]", err);
        res.status(500).json({ message: "Gagal menghapus lampiran" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// APPROVE  (supervisor / direktur)
// ════════════════════════════════════════════════════════════════════════════
export const approvePR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        const jobLevel = Number(me.job_level_id);

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const pr = rows[0];

        // Supervisor → approve status 1 → status 2 (hanya untuk dept yang sama)
        if (jobLevel === 3) {
            if (pr.department_id !== me.department_id)
                return res.status(403).json({ message: "Hanya supervisor departemen terkait yang bisa approve" });
            if (Number(pr.status) !== 1)
                return res.status(400).json({ message: "Pengajuan ini tidak menunggu approval supervisor" });

            const spvNote = req.body.spv_note ? sanitize(req.body.spv_note) : null;

            await safeQuery(
                `UPDATE tr_purchase_request SET status = 2, approved_spv_by = ?, approved_spv_at = NOW(), spv_note = ?, updated_at = NOW()
                 WHERE pr_id = ?`,
                [employeeId, spvNote, id]
            );
            const logNote = spvNote ? `Disetujui supervisor | Catatan: ${spvNote}` : "Disetujui supervisor";
            await writeLog(id, "approved_spv", employeeId, me.full_name, logNote);
            return res.json({ message: "Pengajuan disetujui" });
        }

        // Direktur (1) atau Manager (2) → approve status 2 → status 3
        if (jobLevel === 1 || jobLevel === 2) {
            if (Number(pr.status) !== 2)
                return res.status(400).json({ message: "Pengajuan ini tidak menunggu approval direktur" });

            await safeQuery(
                `UPDATE tr_purchase_request SET status = 3, approved_bod_by = ?, approved_bod_at = NOW(), updated_at = NOW()
                 WHERE pr_id = ?`,
                [employeeId, id]
            );
            await writeLog(id, "approved_bod", employeeId, me.full_name, "Disetujui direktur");
            return res.json({ message: "Pengajuan disetujui direktur" });
        }

        return res.status(403).json({ message: "Anda tidak memiliki hak approve" });
    } catch (err) {
        console.error("[approvePR]", err);
        res.status(500).json({ message: "Gagal approve pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// REJECT  (supervisor / direktur)
// ════════════════════════════════════════════════════════════════════════════
export const rejectPR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        const jobLevel = Number(me.job_level_id);

        const reason = sanitize(req.body.reason);
        if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const pr = rows[0];

        if (jobLevel === 3) {
            if (pr.department_id !== me.department_id)
                return res.status(403).json({ message: "Tidak diizinkan" });
            if (Number(pr.status) !== 1)
                return res.status(400).json({ message: "Pengajuan tidak bisa ditolak pada status ini" });
        } else if (jobLevel === 1 || jobLevel === 2) {
            if (![1, 2].includes(Number(pr.status)))
                return res.status(400).json({ message: "Pengajuan tidak bisa ditolak pada status ini" });
        } else {
            return res.status(403).json({ message: "Anda tidak memiliki hak menolak" });
        }

        await safeQuery(
            `UPDATE tr_purchase_request SET status = 9, rejected_by = ?, rejected_at = NOW(),
                rejection_reason = ?, updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, reason, id]
        );
        await writeLog(id, "rejected", employeeId, me.full_name, reason);

        res.json({ message: "Pengajuan ditolak" });
    } catch (err) {
        console.error("[rejectPR]", err);
        res.status(500).json({ message: "Gagal menolak pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST ALL  (Finance / GA — seluruh pengajuan semua karyawan)
// ════════════════════════════════════════════════════════════════════════════
export const listAll = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGAFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA" });
        }

        const page   = Math.max(1, parseInt(req.query.page) || 1);
        const limit  = Math.min(100, parseInt(req.query.limit) || 20);
        const offset = (page - 1) * limit;
        const search = req.query.search?.trim() || "";
        const status = req.query.status ? Number(req.query.status) : null;
        const type   = req.query.type?.trim() || "";

        const conditions = ["pr.is_deleted = 0"];
        const params = [];

        if (search) {
            conditions.push("(pr.nama_barang LIKE ? OR pr.pr_code LIKE ? OR e.full_name LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        if (status !== null) { conditions.push("pr.status = ?"); params.push(status); }
        if (type)            { conditions.push("pr.type = ?");   params.push(type); }

        const paymentMethod = req.query.payment_method?.trim() || "";
        if (paymentMethod)   { conditions.push("pr.payment_method = ?"); params.push(paymentMethod); }

        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const countRows = await safeQuery(
            `SELECT COUNT(*) AS total
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee e ON e.employee_id = pr.employee_id
             ${where}`,
            params
        );
        const total = Number(countRows[0].total);

        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name,
                    COALESCE((SELECT SUM(p.nominal_bayar)
                              FROM tr_purchase_request_payment p
                              WHERE p.pr_id = pr.pr_id), 0) AS total_paid
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             ${where}
             ORDER BY pr.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );

        res.json({ data, total, page, limit });
    } catch (err) {
        console.error("[listAll]", err);
        res.status(500).json({ message: "Gagal memuat data" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST GA REVIEW  (GA — pengajuan status 2 atau 3 yang menunggu persetujuan GA)
// ════════════════════════════════════════════════════════════════════════════
export const listGaReview = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGA(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya General Affair" });
        }

        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             WHERE pr.is_deleted = 0 AND pr.status IN (2, 3)
             ORDER BY pr.created_at ASC`
        );

        res.json({ data });
    } catch (err) {
        console.error("[listGaReview]", err);
        res.status(500).json({ message: "Gagal memuat data GA review" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// APPROVE GA  (General Affair → status 3 → 4, bisa edit qty/merk/vendor/note)
// ════════════════════════════════════════════════════════════════════════════
export const approveGA = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGA(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya General Affair" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const pr = rows[0];

        if (![2, 3].includes(Number(pr.status))) {
            return res.status(400).json({ message: "Pengajuan belum disetujui Supervisor" });
        }

        // GA dapat override qty, merk, note
        const gaQty    = req.body.ga_qty    ? Number(req.body.ga_qty)            : Number(pr.qty);
        const gaMerk   = req.body.ga_merk   ? titleCase(sanitize(req.body.ga_merk)) : (pr.merk ? titleCase(pr.merk) : null);
        const gaNote   = req.body.ga_note   ? sanitize(req.body.ga_note)            : null;

        // Vendor mode: 'vendor' atau 'link'
        const vendorMode = ["vendor", "link"].includes(req.body.vendor_mode) ? req.body.vendor_mode : null;
        if (!vendorMode) return res.status(400).json({ message: "Pilihan vendor/link wajib diisi" });

        let vendorName = null;
        let vendorId   = null;
        let linkUrl    = null;
        let linkTitle  = null;

        if (vendorMode === "vendor") {
            // vendor_id opsional (bisa custom text)
            vendorId   = req.body.vendor_id ? Number(req.body.vendor_id) : null;
            vendorName = req.body.vendor ? titleCase(sanitize(req.body.vendor)) : null;
            if (!vendorName && !vendorId) {
                return res.status(400).json({ message: "Nama vendor wajib diisi atau pilih dari daftar" });
            }
            // Jika vendor_id ada, ambil nama dari mst_vendor
            if (vendorId && !vendorName) {
                const vRows = await safeQuery(`SELECT nama_vendor FROM mst_vendor WHERE id = ?`, [vendorId]);
                vendorName = vRows.length ? vRows[0].nama_vendor : null;
            }
        } else {
            // link mode — GA bisa edit link yang sudah diisi karyawan
            linkUrl   = req.body.link_url   ? sanitize(req.body.link_url)   : null;
            linkTitle = req.body.link_title  ? sanitize(req.body.link_title) : null;
            if (!linkUrl)   return res.status(400).json({ message: "Link URL wajib diisi" });
            if (!linkTitle) return res.status(400).json({ message: "Judul link wajib diisi" });
        }

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 4,
                approved_ga_by = ?, approved_ga_at = NOW(),
                ga_qty = ?, ga_merk = ?, vendor = ?, vendor_mode = ?, vendor_id = ?,
                link_url = ?, link_title = ?, ga_note = ?,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, gaQty, gaMerk, vendorName, vendorMode, vendorId, linkUrl, linkTitle, gaNote, id]
        );

        const noteText = [
            "Disetujui GA",
            vendorMode === "vendor" ? `Vendor: ${vendorName}` : `Link: ${linkTitle} (${linkUrl})`,
            gaQty   ? `Qty direvisi: ${gaQty}` : null,
            gaMerk  ? `Merk direvisi: ${gaMerk}` : null,
            gaNote  ? `Catatan: ${gaNote}` : null,
        ].filter(Boolean).join(" | ");

        await writeLog(id, "approved_ga", employeeId, me.full_name, noteText);

        res.json({ message: "Pengajuan disetujui GA — PO siap diterbitkan" });
    } catch (err) {
        console.error("[approveGA]", err);
        res.status(500).json({ message: "Gagal approve GA" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// REJECT GA  (General Affair — bisa menolak pengajuan yang sudah lolos Dir)
// ════════════════════════════════════════════════════════════════════════════
export const rejectGA = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGA(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya General Affair" });
        }

        const reason = sanitize(req.body.reason);
        if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT status FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        if (![2, 3].includes(Number(rows[0].status))) {
            return res.status(400).json({ message: "Pengajuan tidak bisa ditolak pada status ini" });
        }

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 9, rejected_by = ?, rejected_at = NOW(),
                rejection_reason = ?, updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, reason, id]
        );
        await writeLog(id, "rejected_ga", employeeId, me.full_name, reason);

        res.json({ message: "Pengajuan ditolak oleh GA" });
    } catch (err) {
        console.error("[rejectGA]", err);
        res.status(500).json({ message: "Gagal menolak pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// GENERATE PO PDF  (Finance / GA — generate Purchase Request number)
// Returns structured data; PDF rendering dilakukan di frontend
// ════════════════════════════════════════════════════════════════════════════
export const getPOData = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGAFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT pr.*,
                    e.full_name AS pengaju_name, e.employee_code,
                    d.department_name,
                    s.satuan_name,
                    c.company_name,
                    c.address     AS company_address,
                    o.full_name AS outlet_name,
                    o.address     AS outlet_address,
                    bnk.bank_name,
                    spv_e.full_name AS spv_name,
                    bod_e.full_name AS bod_name,
                    ga_e.full_name  AS ga_name,
                    fin_e.full_name AS finance_spv_name,
                    dir_e.full_name AS director_name,
                    v.nama_vendor   AS vendor_nama_from_master,
                    v.alamat        AS vendor_alamat,
                    v.no_telepon_1  AS vendor_telepon
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e     ON e.employee_id     = pr.employee_id
             LEFT JOIN mst_department d     ON d.department_id   = pr.department_id
             LEFT JOIN mst_satuan     s     ON s.satuan_id       = pr.satuan_id
             LEFT JOIN mst_company    c     ON c.company_id      = pr.company_id
             LEFT JOIN mst_outlet     o     ON o.id              = pr.outlet_id
             LEFT JOIN mst_bank       bnk   ON bnk.bank_id       = pr.bank_id
             LEFT JOIN mst_employee   spv_e ON spv_e.employee_id = pr.approved_spv_by
             LEFT JOIN mst_employee   bod_e ON bod_e.employee_id = pr.approved_bod_by
             LEFT JOIN mst_employee   ga_e  ON ga_e.employee_id  = pr.approved_ga_by
             LEFT JOIN mst_employee   fin_e ON fin_e.employee_id = pr.approved_finance_by
             LEFT JOIN mst_employee   dir_e ON dir_e.employee_id = 2
             LEFT JOIN mst_vendor     v     ON v.id              = pr.vendor_id
             WHERE pr.pr_id = ? AND pr.is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        // PR tersedia mulai status 2 (SPV approved), PO mulai status 4 (GA approved)
        // Endpoint ini melayani keduanya — frontend menentukan dokumen mana yang ditampilkan
        if (Number(rows[0].status) < 2 || Number(rows[0].status) === 9) {
            return res.status(400).json({ message: "Dokumen belum tersedia pada status ini" });
        }

        res.json({ data: rows[0] });
    } catch (err) {
        console.error("[getPOData]", err);
        res.status(500).json({ message: "Gagal memuat data PO" });
    }
};


// ════════════════════════════════════════════════════════════════════════════
// LIST FINANCE REVIEW  (SPV Finance — status 4 yang menunggu approval finance)
// ════════════════════════════════════════════════════════════════════════════
export const listFinanceReview = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }

        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             WHERE pr.is_deleted = 0 AND pr.status = 4
             ORDER BY pr.created_at ASC`
        );

        res.json({ data });
    } catch (err) {
        console.error("[listFinanceReview]", err);
        res.status(500).json({ message: "Gagal memuat data finance review" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// APPROVE FINANCE SPV  (status 4 → 5, Menunggu Pembayaran)
// ════════════════════════════════════════════════════════════════════════════
export const approveFinance = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }
        // SPV finance only (job_level 3 = supervisor)
        if (Number(me.job_level_id) !== 3) {
            return res.status(403).json({ message: "Hanya SPV Finance yang bisa approve" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        if (Number(rows[0].status) !== 4) {
            return res.status(400).json({ message: "Pengajuan belum disetujui GA" });
        }

        const finNote = req.body.finance_note ? sanitize(req.body.finance_note) : null;

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 5,
                approved_finance_by = ?, approved_finance_at = NOW(),
                finance_note = ?,
                approved_bod_by = ?, approved_bod_at = NOW(),
                updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, finNote, 2, id]
        );

        await writeLog(id, "approved_finance", employeeId, me.full_name,
            finNote ? `Disetujui SPV Finance | ${finNote}` : "Disetujui SPV Finance — menunggu pembayaran");

        // Direktur otomatis approve bersamaan dengan SPV Finance
        const dirRows = await safeQuery(`SELECT full_name FROM mst_employee WHERE employee_id = 2 LIMIT 1`);
        const dirName = dirRows.length ? dirRows[0].full_name : "Direktur";
        await writeLog(id, "approved_bod", 2, dirName, "Disetujui Direktur (otomatis bersamaan dengan SPV Finance)");

        res.json({ message: "Disetujui SPV Finance — menunggu pembayaran" });
    } catch (err) {
        console.error("[approveFinance]", err);
        res.status(500).json({ message: "Gagal approve finance" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// REJECT FINANCE  (SPV Finance — tolak status 4)
// ════════════════════════════════════════════════════════════════════════════
export const rejectFinance = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }

        const reason = sanitize(req.body.reason);
        if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT status FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        if (Number(rows[0].status) !== 4) {
            return res.status(400).json({ message: "Pengajuan tidak bisa ditolak pada status ini" });
        }

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 9, rejected_by = ?, rejected_at = NOW(),
                rejection_reason = ?, updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, reason, id]
        );
        await writeLog(id, "rejected_finance", employeeId, me.full_name, reason);

        res.json({ message: "Pengajuan ditolak oleh SPV Finance" });
    } catch (err) {
        console.error("[rejectFinance]", err);
        res.status(500).json({ message: "Gagal menolak pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST PAYMENT PENDING  (Staff Finance — status 5, menunggu pembayaran)
// ════════════════════════════════════════════════════════════════════════════
export const listPaymentPending = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }

        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             WHERE pr.is_deleted = 0 AND pr.status = 5
             ORDER BY pr.created_at ASC`
        );

        res.json({ data });
    } catch (err) {
        console.error("[listPaymentPending]", err);
        res.status(500).json({ message: "Gagal memuat data pembayaran" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// PROCESS PAYMENT  (Staff Finance — status 5 → 6, upload bukti bayar)
// ════════════════════════════════════════════════════════════════════════════
export const processPayment = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        if (Number(rows[0].status) !== 5) {
            return res.status(400).json({ message: "Pengajuan belum siap untuk pembayaran" });
        }

        const classification = ["inventory", "expense"].includes(req.body.classification) ? req.body.classification : null;
        if (!classification) return res.status(400).json({ message: "Klasifikasi (Inventory/Expense) wajib dipilih" });

        const paymentMethod = ["cash", "kredit"].includes(req.body.payment_method) ? req.body.payment_method : null;
        if (!paymentMethod) return res.status(400).json({ message: "Metode pembayaran (Cash/Kredit) wajib dipilih" });

        let terminValue = null;
        let terminUnit  = null;
        let jatuhTempo  = null;

        if (paymentMethod === "kredit") {
            terminValue = req.body.termin_value ? Number(req.body.termin_value) : null;
            terminUnit  = ["hari", "bulan", "tahun"].includes(req.body.termin_unit) ? req.body.termin_unit : null;
            if (!terminValue || !terminUnit) {
                return res.status(400).json({ message: "Termin wajib diisi untuk pembayaran kredit" });
            }
            // Hitung jatuh tempo dari sekarang
            const now = new Date();
            if (terminUnit === "hari") {
                now.setDate(now.getDate() + terminValue);
            } else if (terminUnit === "bulan") {
                now.setMonth(now.getMonth() + terminValue);
            } else if (terminUnit === "tahun") {
                now.setFullYear(now.getFullYear() + terminValue);
            }
            jatuhTempo = now.toISOString().split("T")[0];
        }

        const paymentNote = req.body.payment_note ? sanitize(req.body.payment_note) : null;

        // Nominal bayar aktual (default = estimasi_harga * qty jika tidak diisi)
        const nominalBayarRaw = req.body.nominal_bayar ? Number(req.body.nominal_bayar) : null;
        const nominalBayar = nominalBayarRaw || null;

        // File bukti bayar dari multer (bisa multi-file, max 5)
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ message: "Bukti pembayaran wajib dilampirkan" });
        const proofPath = `purchase/${files[0].filename}`; // path utama (file pertama)

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 6,
                classification = ?,
                payment_method = ?,
                termin_value = ?, termin_unit = ?, jatuh_tempo = ?,
                nominal_bayar = ?,
                paid_by = ?, paid_at = NOW(),
                payment_proof_path = ?,
                payment_note = ?,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [classification, paymentMethod, terminValue, terminUnit, jatuhTempo, nominalBayar, employeeId, proofPath, paymentNote, id]
        );

        // Catat di tabel payment HANYA untuk metode CASH (langsung lunas).
        // Untuk KREDIT: nominal_bayar di tabel PR adalah TARGET yang harus
        // dibayar, bukan jumlah yg sudah dibayar. Pembayaran kredit dicatat
        // satu per satu lewat endpoint addInstallment supaya sisa terhitung
        // benar dan riwayat akurat.
        if (paymentMethod === "cash") {
            await safeQuery(
                `INSERT INTO tr_purchase_request_payment
                    (pr_id, nominal_bayar, proof_path, note, paid_by, paid_by_name, paid_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW())`,
                [id, nominalBayar || 0, proofPath, paymentNote, employeeId, me.full_name]
            );
        }

        // Simpan semua file bukti sebagai attachment PR (termasuk file pertama)
        for (const f of files) {
            await safeQuery(
                `INSERT INTO tr_purchase_request_attachment
                    (pr_id, file_path, original_name, mime_type, file_size_kb)
                 VALUES (?, ?, ?, ?, ?)`,
                [id, `purchase/${f.filename}`, f.originalname, f.mimetype, Math.round(f.size / 1024)]
            );
        }

        const terminLabel = paymentMethod === "kredit" ? ` | Termin: ${terminValue} ${terminUnit} (jatuh tempo: ${jatuhTempo})` : "";
        const nominalLabel = nominalBayar
            ? (paymentMethod === "kredit"
                ? ` | Total Tagihan Kredit: Rp ${new Intl.NumberFormat("id-ID").format(nominalBayar)}`
                : ` | Nominal Bayar: Rp ${new Intl.NumberFormat("id-ID").format(nominalBayar)}`)
            : "";
        const noteText = `${paymentMethod === "kredit" ? "PR diterbitkan (Kredit)" : "Pembayaran dilakukan"} | Metode: ${paymentMethod} | Klasifikasi: ${classification}${terminLabel}${nominalLabel}${paymentNote ? ` | ${paymentNote}` : ""}`;
        await writeLog(id, "paid", employeeId, me.full_name, noteText);

        const successMsg = paymentMethod === "kredit"
            ? "PR diterbitkan sebagai kredit — cicilan dapat dicatat melalui menu pelunasan"
            : "Pembayaran berhasil dicatat — menunggu invoice dari pengaju";
        res.json({ message: successMsg });
    } catch (err) {
        console.error("[processPayment]", err);
        res.status(500).json({ message: "Gagal memproses pembayaran" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// COMPLETE  (Karyawan pengaju — status 6 → 7, upload invoice)
// ════════════════════════════════════════════════════════════════════════════
export const completePR = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });

        // Boleh complete: pengaju ATAU GA
        const isPengaju = rows[0].employee_id === employeeId;
        const isGAUser  = isGA(me.position_name);
        if (!isPengaju && !isGAUser) {
            return res.status(403).json({ message: "Hanya pengaju atau GA yang bisa melengkapi" });
        }
        if (Number(rows[0].status) !== 6) {
            return res.status(400).json({ message: "Pengajuan belum dalam status Terbayar" });
        }

        const file = req.files?.[0] || null;
        const invoicePath = file ? `purchase/${file.filename}` : null;
        if (!invoicePath) return res.status(400).json({ message: "Invoice/bukti wajib dilampirkan" });

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 7,
                completed_by = ?, completed_at = NOW(),
                invoice_proof_path = ?,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, invoicePath, id]
        );

        await writeLog(id, "completed", employeeId, me?.full_name, "Pengajuan selesai — invoice dilampirkan");

        res.json({ message: "Pengajuan selesai" });
    } catch (err) {
        console.error("[completePR]", err);
        res.status(500).json({ message: "Gagal menyelesaikan pengajuan" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// LIST KREDIT  (Finance / GA — daftar PR kredit beserta status pelunasan)
//
// Mengembalikan setiap PR kredit + kolom turunan:
//   total_paid   = SUM(payment.nominal_bayar)
//   sisa         = nominal_bayar - total_paid
//   is_lunas     = sisa <= 0
//
// Filter:
//   ?status=unpaid  → hanya yang belum lunas
//   ?status=paid    → hanya yang sudah lunas
//   ?department_id  → filter per departemen
//   ?date_from / ?date_to → filter rentang tanggal pengajuan
// ════════════════════════════════════════════════════════════════════════════
export const listCredit = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGAFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA" });
        }

        const conditions = [
            "pr.is_deleted = 0",
            "pr.payment_method = 'kredit'",
            "pr.status >= 6",
            "pr.status != 9",
        ];
        const params = [];

        const search = req.query.search?.trim() || "";
        if (search) {
            conditions.push("(pr.nama_barang LIKE ? OR pr.pr_code LIKE ? OR e.full_name LIKE ?)");
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        const departmentIdRaw = req.query.department_id;
        // Skip filter jika "all" atau kosong
        const departmentId = (departmentIdRaw && departmentIdRaw !== "all")
            ? Number(departmentIdRaw)
            : null;
        if (departmentId) {
            conditions.push("pr.department_id = ?");
            params.push(departmentId);
        }

        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        const data = await safeQuery(
            `SELECT pr.*,
                    e.full_name AS pengaju_name,
                    d.department_name,
                    s.satuan_name,
                    c.company_name,
                    o.full_name AS outlet_name,
                    COALESCE((SELECT SUM(p.nominal_bayar)
                              FROM tr_purchase_request_payment p
                              WHERE p.pr_id = pr.pr_id), 0) AS total_paid
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o ON o.id            = pr.outlet_id
             ${where}
             ORDER BY pr.created_at DESC`,
            params
        );

        // hitung sisa & is_lunas per row
        // Lunas jika sisa = 0 DAN sudah ada pembayaran (totalPaid > 0).
        // target boleh 0 (kalau Finance approve tanpa set nominal target)
        // — yang penting ada record pembayaran berarti sudah dibayar.
        const filterStatus = req.query.status?.trim() || ""; // "unpaid" | "paid" | ""
        const enriched = data.map(r => {
            const target = Number(r.nominal_bayar) || 0;
            const paid   = Number(r.total_paid)    || 0;
            const sisa   = Math.max(0, target - paid);
            const isLunas = sisa <= 0 && (target > 0 || paid > 0);
            return { ...r, total_paid: paid, sisa, is_lunas: isLunas };
        });

        const filtered = filterStatus === "unpaid"
            ? enriched.filter(r => !r.is_lunas)
            : filterStatus === "paid"
            ? enriched.filter(r =>  r.is_lunas)
            : enriched;

        // aggregate
        const totalTarget = enriched.reduce((s, r) => s + (Number(r.nominal_bayar) || 0), 0);
        const totalPaid   = enriched.reduce((s, r) => s + r.total_paid, 0);
        const totalSisa   = Math.max(0, totalTarget - totalPaid);

        res.json({
            data: filtered,
            total: filtered.length,
            summary: {
                totalTarget,
                totalPaid,
                totalSisa,
                countAll:    enriched.length,
                countUnpaid: enriched.filter(r => !r.is_lunas).length,
                countPaid:   enriched.filter(r =>  r.is_lunas).length,
            },
        });
    } catch (err) {
        console.error("[listCredit]", err);
        res.status(500).json({ message: "Gagal memuat data kredit" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// PAYMENT HISTORY  (Finance / GA — riwayat cicilan untuk satu PR)
// ════════════════════════════════════════════════════════════════════════════
export const getPaymentHistory = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });

        const { id } = req.params;
        const prRows = await safeQuery(
            `SELECT pr.pr_id, pr.pr_code, pr.nama_barang, pr.qty, pr.estimasi_harga,
                    pr.payment_method, pr.nominal_bayar, pr.termin_value, pr.termin_unit,
                    pr.jatuh_tempo, pr.status, pr.employee_id,
                    e.full_name AS pengaju_name,
                    d.department_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d ON d.department_id = pr.department_id
             WHERE pr.pr_id = ? AND pr.is_deleted = 0`,
            [id]
        );
        if (!prRows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const pr = prRows[0];

        const payments = await safeQuery(
            `SELECT * FROM tr_purchase_request_payment
             WHERE pr_id = ?
             ORDER BY paid_at ASC, payment_id ASC`,
            [id]
        );

        const totalPaid = payments.reduce((s, p) => s + Number(p.nominal_bayar || 0), 0);
        const target    = Number(pr.nominal_bayar) || 0;
        const sisa      = Math.max(0, target - totalPaid);
        const isLunas   = sisa <= 0 && (target > 0 || totalPaid > 0);

        res.json({
            pr,
            payments,
            summary: {
                target,
                totalPaid,
                sisa,
                isLunas,
            },
        });
    } catch (err) {
        console.error("[getPaymentHistory]", err);
        res.status(500).json({ message: "Gagal memuat riwayat pembayaran" });
    }
};

// ════════════════════════════════════════════════════════════════════════════
// ADD INSTALLMENT  (Finance — tambah cicilan/pelunasan untuk PR kredit)
//
// Body (multipart/form-data):
//   - nominal_bayar  (required, numeric)
//   - note           (optional)
//   - attachments    (file, required: bukti bayar)
//
// Aturan:
//   - PR harus payment_method = 'kredit' dan status = 6 (Terbayar) — masih
//     dianggap "belum lunas" selama sisa > 0.
//   - Hanya Finance (staff/spv) yang boleh.
//   - Jika nominal cicilan ≥ sisa, PR otomatis dianggap LUNAS (tetapi status
//     tetap 6, frontend menampilkan "Lunas (Kredit)").
// ════════════════════════════════════════════════════════════════════════════
export const addInstallment = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isFinance(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT * FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });
        const pr = rows[0];

        if (pr.payment_method !== "kredit") {
            return res.status(400).json({ message: "Hanya pembayaran kredit yang dapat dicicil" });
        }
        if (Number(pr.status) !== 6) {
            return res.status(400).json({ message: "PR ini tidak dalam tahap pembayaran" });
        }

        // validasi sisa
        const paidRows = await safeQuery(
            `SELECT COALESCE(SUM(nominal_bayar), 0) AS total_paid
             FROM tr_purchase_request_payment WHERE pr_id = ?`,
            [id]
        );
        const totalPaid = Number(paidRows[0]?.total_paid) || 0;
        const target    = Number(pr.nominal_bayar) || 0;
        const sisa      = Math.max(0, target - totalPaid);

        if (sisa <= 0) {
            return res.status(400).json({ message: "PR ini sudah lunas" });
        }

        const nominalBayarRaw = req.body.nominal_bayar ? Number(req.body.nominal_bayar) : 0;
        if (!nominalBayarRaw || nominalBayarRaw <= 0) {
            return res.status(400).json({ message: "Nominal bayar wajib diisi" });
        }
        if (nominalBayarRaw > sisa + 0.01) {
            return res.status(400).json({
                message: `Nominal bayar (Rp ${new Intl.NumberFormat("id-ID").format(nominalBayarRaw)}) melebihi sisa hutang (Rp ${new Intl.NumberFormat("id-ID").format(sisa)})`,
            });
        }

        const note = req.body.note ? sanitize(req.body.note) : null;

        // Tanggal bayar (opsional). Format YYYY-MM-DD. Default: NOW().
        // Tidak boleh di masa depan.
        let paidAtSql = "NOW()";
        const paidAtParams = [];
        const paidAtRaw = req.body.paid_at?.trim();
        if (paidAtRaw) {
            // Validasi format YYYY-MM-DD
            if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAtRaw)) {
                return res.status(400).json({ message: "Format tanggal bayar tidak valid (YYYY-MM-DD)" });
            }
            const paidDate = new Date(`${paidAtRaw}T00:00:00`);
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            if (Number.isNaN(paidDate.getTime())) {
                return res.status(400).json({ message: "Tanggal bayar tidak valid" });
            }
            if (paidDate > today) {
                return res.status(400).json({ message: "Tanggal bayar tidak boleh di masa depan" });
            }
            paidAtSql = "?";
            paidAtParams.push(`${paidAtRaw} ${new Date().toTimeString().slice(0, 8)}`);
        }

        // bukti bayar
        const file = req.files?.[0] || null;
        const proofPath = file ? `purchase/${file.filename}` : null;
        if (!proofPath) {
            return res.status(400).json({ message: "Bukti pembayaran wajib dilampirkan" });
        }

        await safeQuery(
            `INSERT INTO tr_purchase_request_payment
                (pr_id, nominal_bayar, proof_path, note, paid_by, paid_by_name, paid_at)
             VALUES (?, ?, ?, ?, ?, ?, ${paidAtSql})`,
            [id, nominalBayarRaw, proofPath, note, employeeId, me.full_name, ...paidAtParams]
        );

        // update timestamp PR
        await safeQuery(
            `UPDATE tr_purchase_request SET updated_at = NOW() WHERE pr_id = ?`,
            [id]
        );

        const newSisa = Math.max(0, sisa - nominalBayarRaw);
        const isLunas = newSisa <= 0;

        const noteText = isLunas
            ? `Pelunasan kredit | Cicilan: Rp ${new Intl.NumberFormat("id-ID").format(nominalBayarRaw)} (LUNAS)${note ? ` | ${note}` : ""}`
            : `Cicilan kredit | Bayar: Rp ${new Intl.NumberFormat("id-ID").format(nominalBayarRaw)} | Sisa: Rp ${new Intl.NumberFormat("id-ID").format(newSisa)}${note ? ` | ${note}` : ""}`;
        await writeLog(id, isLunas ? "paid_full" : "paid_installment", employeeId, me.full_name, noteText);

        res.json({
            message: isLunas ? "Pembayaran lunas" : "Cicilan tercatat",
            sisa: newSisa,
            is_lunas: isLunas,
        });
    } catch (err) {
        console.error("[addInstallment]", err);
        res.status(500).json({ message: "Gagal mencatat pembayaran" });
    }
};
