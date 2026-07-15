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
// Flow approval PENGAJUAN:
//   - Staff create          -> status = 1
//   - Supervisor approve    -> status = 2
//   - Direktur approve      -> status = 3 (default auto)
//   - GA approve            -> status = 4
//   - SPV Finance approve   -> status = 5 (Menunggu Pembayaran)
//   - Staff Finance bayar   -> status = 6 (Paid/Terbayar)
//   - Karyawan upload inv   -> status = 7 (Selesai)
//   - Reject (any auth)     -> status = 9
//
// Flow approval GA RUTIN (GA memilih "Rutin" saat create):
//   - GA create langsung    -> status = 4 (skip SPV dept & GA review)
//   - SPV Finance approve   -> status = 5
//   - ...sama seperti biasa
//
// Flow approval GA TIDAK RUTIN:
//   - GA create langsung    -> status = 1 (tapi GA fields sudah diisi)
//   - SPV Dept approve      -> status = 4 (langsung PR Ready, skip GA review & BOD)
//   - SPV Finance approve   -> status = 5
//   - ...sama seperti biasa
//
// Flow approval REIMBURSE (berbeda):
//   - Staff create           -> status = 1
//   - SPV Departemen approve -> status = 2
//   - SPV Finance approve    -> status = 5 (BoD auto-approve bersamaan,
//                                            langsung ke "Menunggu Pembayaran")
//   - Team Finance bayar     -> status = 7 (Selesai — finance upload bukti
//                                            sekaligus = penyelesaian)
//   - Reject (SPV Dept / SPV Finance) -> status = 9
//
//   NOTE penting:
//     • Reimburse TIDAK melewati Direktur manual (status 3): BoD auto via SPV Finance.
//     • Reimburse TIDAK melewati GA (status 4): Tidak ada PO/vendor.
//     • Reimburse TIDAK melalui status 6: Pembayaran finance LANGSUNG selesai (7).
//     • Pembayaran reimburse selalu CASH (sekali bayar). Tidak ada cicilan.
//
// MULTI-INSTALLMENT PAYMENT (cicilan) — KREDIT:
//   - Pembayaran kredit dapat dilakukan beberapa kali (cicilan) sampai lunas.
//   - Setiap cicilan disimpan di tr_purchase_request_payment.
//   - Total dibayar = SUM(nominal_bayar) di tabel payment.
//   - Sisa = tr_purchase_request.nominal_bayar (target) - total dibayar.
//   - Status tetap = 6 selama sisa > 0 (frontend menampilkan "Belum Lunas" /
//     "Belum Terbayar"). Pembayaran cash juga tercatat 1 baris (lunas sekali bayar).
//
// Aturan edit/hapus:
//   - Karyawan biasa: hanya saat status IN (1, 2, 9)
//   - GA: bisa edit/hapus kapan pun selama status < 5 (sebelum Finance approve)
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

const generatePrCode = async (type = "pengajuan") => {
    const ym = new Date();
    const codeType = type === "reimburse" ? "RM" : "PR";
    const yy = String(ym.getFullYear()).slice(-2);
    const mm = String(ym.getMonth() + 1).padStart(2, "0");
    const prefix = `${codeType}-${yy}${mm}`;
    const exactLen = prefix.length + 3; // "PR-2606" (7) + "001" (3) = 10
    // Ambil seq tertinggi dari kode normal saja (skip kode corrupt yg lebih panjang)
    const rows = await safeQuery(
        `SELECT MAX(CAST(SUBSTRING(pr_code, ${exactLen - 2}) AS UNSIGNED)) AS max_seq
         FROM tr_purchase_request
         WHERE pr_code LIKE ? AND LENGTH(pr_code) = ?`,
        [`${prefix}%`, exactLen]
    );
    const maxSeq = rows[0]?.max_seq || 0;
    const seq = maxSeq + 1;
    return `${prefix}${String(seq).padStart(3, "0")}`;
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

const canViewAllActivities = (employee) => {
    if (!employee) return false;
    return isGAFinance(employee.position_name) || Number(employee.job_level_id) === 1;
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

export const getClassifications = async (_req, res) => {
    try {
        const data = await safeQuery(
            `SELECT id, classification_name FROM mst_purchase_classification WHERE is_active = 1 ORDER BY classification_name`
        );
        res.json({ data });
    } catch (err) {
        console.error("[getClassifications]", err);
        res.status(500).json({ message: "Gagal memuat klasifikasi" });
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
            const isFinanceGA = canViewAllActivities(me);

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
            if (!canViewAllActivities(me)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor semua departemen" });
            }
            showAll = true;
            departmentId = null;
            departmentName = "Semua Departemen";
        } else if (requestedDeptIdRaw && Number(requestedDeptIdRaw) !== me.department_id) {
            // Pastikan boleh override
            if (!canViewAllActivities(me)) {
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
        const limit  = (req.query.limit === "all" || req.query.limit === "ALL")
            ? 999999
            : Math.min(100, parseInt(req.query.limit) || 20);
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
            if (!canViewAllActivities(me)) {
                return res.status(403).json({ message: "Tidak diizinkan memonitor semua departemen" });
            }
            showAll = true;
            departmentId = null;
            departmentName = "Semua Departemen";
        } else if (requestedDeptIdRaw && Number(requestedDeptIdRaw) !== me.department_id) {
            if (!canViewAllActivities(me)) {
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
        const limit  = (req.query.limit === "all" || req.query.limit === "ALL")
            ? 999999
            : Math.min(100, parseInt(req.query.limit) || 10);
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
            // Supervisor: lihat departemennya sendiri yang status 1
            conditions.push("pr.department_id = ?", "pr.status = 1");
            params.push(me.department_id);
            const type = req.query.type?.trim() || "";
            if (type) { conditions.push("pr.type = ?"); params.push(type); }
        } else if (jobLevel === 2) {
            // Manager: status 1 atau 2, hanya pengajuan biasa (bukan reimburse)
            conditions.push("pr.status IN (1, 2)", "pr.type = 'pengajuan'");
        } else {
            // Direktur (1): status 2, hanya pengajuan biasa (reimburse tidak ke Direktur manual)
            conditions.push("pr.status = 2", "pr.type = 'pengajuan'");
        }

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

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
                    bnk.bank_name, pc.classification_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e   ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d   ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s   ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c   ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o   ON o.id            = pr.outlet_id
             LEFT JOIN mst_bank       bnk ON bnk.bank_id     = pr.bank_id
             LEFT JOIN mst_purchase_classification pc ON pc.id = pr.classification_id
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
        // Outlet tidak wajib diisi lagi untuk Waschen (company_id === 5)

        // Reimburse-only fields
        let bankId = null, nomorRekening = null, atasNama = null;
        if (type === "reimburse") {
            bankId        = req.body.bank_id ? Number(req.body.bank_id) : (me.bank_id || null);
            nomorRekening = sanitize(req.body.bank_account_number) || me.bank_account_number || null;
            atasNama      = titleCase(sanitize(req.body.atas_nama));
            if (!atasNama) return res.status(400).json({ message: "Atas Nama wajib diisi" });
        }

        const prCode = await generatePrCode(type);

        const jobLevel = Number(me.job_level_id);

        // ── FLOW REIMBURSE: tidak ada GA, tidak ada auto-approve SPV level ──────
        // Reimburse selalu mulai dari status 1 (menunggu SPV Departemen), kecuali
        // pengaju sendiri adalah SPV dept (job_level 3) → auto-approve SPV.
        if (type === "reimburse") {
            const autoSpvReimburse = jobLevel <= 3;
            const initialStatus    = autoSpvReimburse ? 2 : 1;

            const insertResult = await safeQuery(
                `INSERT INTO tr_purchase_request
                    (pr_code, type, employee_id, department_id, tanggal_pengajuan,
                     company_id, outlet_id,
                     nama_barang, deskripsi, merk, qty, satuan_id, estimasi_harga, alasan_pembelian,
                     bank_id, nomor_rekening, atas_nama,
                     status,
                     approved_spv_by, approved_spv_at)
                 VALUES (?, ?, ?, ?, ?,
                         ?, ?,
                         ?, ?, ?, ?, ?, ?, ?,
                         ?, ?, ?,
                         ?,
                         ?, ${autoSpvReimburse ? "NOW()" : "NULL"})`,
                [prCode, type, employeeId, me.department_id, tanggalPengajuan,
                 companyId, outletId,
                 namaBarang, deskripsi, merk, qty, satuanId, estimasiHarga, alasanPembelian,
                 bankId, nomorRekening, atasNama,
                 initialStatus,
                 autoSpvReimburse ? employeeId : null]
            );
            const prId = insertResult.insertId;

            const files = req.files || [];
            for (const file of files) {
                await safeQuery(
                    `INSERT INTO tr_purchase_request_attachment
                        (pr_id, file_path, original_name, mime_type, file_size_kb)
                     VALUES (?, ?, ?, ?, ?)`,
                    [prId, `purchase/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
                );
            }

            await writeLog(prId, "created", employeeId, me.full_name, "Reimburse dibuat & diajukan");
            if (autoSpvReimburse) {
                await writeLog(prId, "approved_spv", employeeId, me.full_name,
                    "Disetujui SPV Departemen (otomatis — pengaju adalah supervisor)");
            }
            return res.status(201).json({ message: "Reimburse berhasil dibuat", pr_id: prId, pr_code: prCode });
        }

        // ── FLOW PENGAJUAN BIASA ────────────────────────────────────────────────
        const linkUrl   = req.body.link_url   ? sanitize(req.body.link_url)   : null;
        const linkTitle = req.body.link_title  ? sanitize(req.body.link_title) : null;
        let vendorMode  = linkUrl ? "link" : null;
        let vendorName  = null;
        let vendorId    = null;
        const isGAUser  = isGA(me.position_name);

        // ── GA-specific flow: rutin/tidak_rutin + GA fills own fields ────────
        let gaRutin    = null;
        let gaQtyVal   = null;
        let gaMerkVal  = null;
        let gaNoteVal  = null;
        let autoApproveSpv = jobLevel <= 3;
        let initialStatus;
        let isRutin = false;

        if (isGAUser && type === "pengajuan") {
            gaRutin = ["rutin", "tidak_rutin"].includes(req.body.is_routine) ? req.body.is_routine : null;
            if (!gaRutin) {
                return res.status(400).json({ message: "Pilih jenis pengajuan Rutin atau Tidak Rutin" });
            }

            isRutin = gaRutin === "rutin";

            // GA fills GA fields directly at submission
            gaQtyVal  = req.body.ga_qty ? Number(req.body.ga_qty) : qty;
            gaMerkVal = req.body.ga_merk ? titleCase(sanitize(req.body.ga_merk)) : (merk || null);
            gaNoteVal = req.body.ga_note ? sanitize(req.body.ga_note) : null;

            // Vendor mode untuk GA: vendor / link / offline
            const gaVendorMode = req.body.vendor_mode;
            if (gaVendorMode) {
                vendorMode = gaVendorMode;
                if (gaVendorMode === "vendor") {
                    vendorId   = req.body.vendor_id ? Number(req.body.vendor_id) : null;
                    vendorName = req.body.vendor ? titleCase(sanitize(req.body.vendor)) : null;
                    if (vendorId && !vendorName) {
                        const vRows = await safeQuery(`SELECT nama_vendor FROM mst_vendor WHERE id = ?`, [vendorId]);
                        vendorName = vRows.length ? vRows[0].nama_vendor : null;
                    }
                    if (!vendorName && !vendorId) {
                        return res.status(400).json({ message: "Nama vendor wajib diisi atau pilih dari daftar" });
                    }
                } else if (gaVendorMode === "link") {
                    if (!linkUrl) return res.status(400).json({ message: "Link URL wajib diisi" });
                    if (!linkTitle) return res.status(400).json({ message: "Judul link wajib diisi" });
                } else if (gaVendorMode === "offline") {
                    const offlineDesc = sanitize(req.body.offline_desc);
                    if (!offlineDesc) {
                        return res.status(400).json({ message: "Keterangan offline wajib diisi (contoh: Supermarket, Foto Kopi Cendikia)" });
                    }
                    vendorName = offlineDesc; // reuse vendor field
                }
            }

            if (isRutin) {
                // GA Rutin: skip SPV dept → status 4 langsung
                initialStatus = 4;
            } else {
                // GA Tidak Rutin: butuh approval SPV dept → status 1
                initialStatus = 1;
            }
        } else {
            // Non-GA flow — existing logic
            const gaVendorModeBody = req.body.vendor_mode;
            if (isGAUser && gaVendorModeBody) {
                vendorMode = gaVendorModeBody;
                if (gaVendorModeBody === "vendor") {
                    vendorId   = req.body.vendor_id ? Number(req.body.vendor_id) : null;
                    vendorName = req.body.vendor ? titleCase(sanitize(req.body.vendor)) : null;
                    if (vendorId && !vendorName) {
                        const vRows = await safeQuery(`SELECT nama_vendor FROM mst_vendor WHERE id = ?`, [vendorId]);
                        vendorName = vRows.length ? vRows[0].nama_vendor : null;
                    }
                }
            }

            const totalEstimasi = (estimasiHarga || 0) * qty;
            const gaFastTrack   = isGAUser && companyId !== 1 && totalEstimasi < 500000;

            if (gaFastTrack) {
                initialStatus = 4;
            } else if (autoApproveSpv) {
                initialStatus = 2;
            } else {
                initialStatus = 1;
            }
        }

        const insertResult = await safeQuery(
            `INSERT INTO tr_purchase_request
                (pr_code, type, is_routine, employee_id, department_id, tanggal_pengajuan,
                 company_id, outlet_id,
                 nama_barang, deskripsi, merk, qty, satuan_id, estimasi_harga, alasan_pembelian,
                 bank_id, nomor_rekening, atas_nama,
                 vendor_mode, vendor, vendor_id, link_url, link_title,
                 status,
                 approved_spv_by, approved_spv_at,
                 approved_ga_by, approved_ga_at,
                 ga_qty, ga_merk, ga_note)
             VALUES (?, ?, ?, ?, ?, ?,
                     ?, ?,
                     ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?,
                     ?, ?, ?, ?, ?,
                     ?,
                     ?, ${isRutin ? "NOW()" : (autoApproveSpv ? "NOW()" : "NULL")},
                     ?, ${isRutin ? "NOW()" : "NULL"},
                     ?, ?, ?)`,
            [prCode, type, gaRutin, employeeId, me.department_id, tanggalPengajuan,
             companyId, outletId,
             namaBarang, deskripsi, merk, qty, satuanId, estimasiHarga, alasanPembelian,
             null, null, null,
             vendorMode, vendorName, vendorId, linkUrl, linkTitle,
             initialStatus,
             isRutin ? employeeId : (autoApproveSpv ? employeeId : null),
             isRutin ? employeeId : null,
             gaQtyVal, gaMerkVal, gaNoteVal]
        );

        const prId = insertResult.insertId;

        const files = req.files || [];
        for (const file of files) {
            await safeQuery(
                `INSERT INTO tr_purchase_request_attachment
                    (pr_id, file_path, original_name, mime_type, file_size_kb)
                 VALUES (?, ?, ?, ?, ?)`,
                [prId, `purchase/${file.filename}`, file.originalname, file.mimetype, Math.round(file.size / 1024)]
            );
        }

        await writeLog(prId, "created", employeeId, me.full_name, "Pengajuan dibuat & diajukan");

        if (isRutin) {
            await writeLog(prId, "approved_spv", employeeId, me.full_name,
                "Disetujui SPV Departemen (otomatis — GA rutin)");
            await writeLog(prId, "approved_ga", employeeId, me.full_name,
                "GA mengisi data langsung — PR siap ke Finance");
        } else if (isGAUser && gaRutin === "tidak_rutin") {
            await writeLog(prId, "ga_filled", employeeId, me.full_name,
                "GA mengisi data langsung, menunggu approval SPV Departemen");
        } else if (autoApproveSpv) {
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
// UPDATE  (hanya pengaju, ketika status IN (1, 2, 9), atau GA kapan pun < 5)
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

        // GA can edit at any status < 5 (before Finance approve)
        const isGAUser = isGA(me.position_name);
        if (isGAUser) {
            if (Number(row.status) >= 5) {
                return res.status(400).json({ message: "Pengajuan sudah diproses Finance, tidak bisa diedit" });
            }
        } else {
            if (![1, 2, 9].includes(Number(row.status))) {
                return res.status(400).json({ message: "Pengajuan pada status ini tidak bisa diedit" });
            }
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
        // Outlet tidak wajib diisi lagi untuk Waschen (company_id === 5)

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
        const vendorMode = linkUrl ? "link" : null;

        // Handle is_routine update for GA
        let gaRutin = row.is_routine;
        if (isGAUser && ["rutin", "tidak_rutin"].includes(req.body.is_routine)) {
            gaRutin = req.body.is_routine;
        }

        // GA fields — only GA can update these
        let gaQtyVal   = row.ga_qty;
        let gaMerkVal  = row.ga_merk;
        let gaNoteVal  = row.ga_note;
        let vendorName = row.vendor;
        let vendorId   = row.vendor_id;
        let vendorModeNew = row.vendor_mode;

        if (isGAUser) {
            const gaVendorMode = req.body.vendor_mode;
            if (gaVendorMode) {
                vendorModeNew = gaVendorMode;
                if (gaVendorMode === "vendor") {
                    vendorId   = req.body.vendor_id ? Number(req.body.vendor_id) : null;
                    vendorName = req.body.vendor ? titleCase(sanitize(req.body.vendor)) : null;
                    if (vendorId && !vendorName) {
                        const vRows = await safeQuery(`SELECT nama_vendor FROM mst_vendor WHERE id = ?`, [vendorId]);
                        vendorName = vRows.length ? vRows[0].nama_vendor : null;
                    }
                } else if (gaVendorMode === "offline") {
                    const offlineDesc = sanitize(req.body.offline_desc);
                    if (offlineDesc) vendorName = offlineDesc;
                } else if (gaVendorMode === "link") {
                    // link captured above
                }
            }

            // GA can update ga_qty, ga_merk, ga_note
            if (req.body.ga_qty != null) gaQtyVal = Number(req.body.ga_qty);
            if (req.body.ga_merk) gaMerkVal = titleCase(sanitize(req.body.ga_merk));
            if (req.body.ga_note != null) gaNoteVal = sanitize(req.body.ga_note);
        }

        // jika sebelumnya rejected, set kembali ke 1
        const newStatus = Number(row.status) === 9 ? 1 : row.status;

        await safeQuery(
            `UPDATE tr_purchase_request SET
                type = ?, is_routine = ?, tanggal_pengajuan = ?, company_id = ?, outlet_id = ?,
                nama_barang = ?, deskripsi = ?, merk = ?, qty = ?, satuan_id = ?,
                estimasi_harga = ?, alasan_pembelian = ?,
                bank_id = ?, nomor_rekening = ?, atas_nama = ?,
                vendor_mode = ?, vendor = ?, vendor_id = ?, link_url = ?, link_title = ?,
                ga_qty = ?, ga_merk = ?, ga_note = ?,
                status = ?, rejection_reason = NULL, rejected_at = NULL, rejected_by = NULL,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [type, gaRutin, tanggalPengajuan, companyId, outletId,
             namaBarang, deskripsi, merk, qty, satuanId, estimasiHarga, alasanPembelian,
             bankId, nomorRekening, atasNama,
             vendorModeNew, vendorName, vendorId, linkUrl, linkTitle,
             gaQtyVal, gaMerkVal, gaNoteVal,
             newStatus, id]
        );

        // tambah lampiran baru
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
// DELETE  (soft delete — hanya pengaju, status IN (1, 2, 9), atau GA kapan pun < 5)
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

        const me = await fetchEmployee(employeeId);
        const isGAUser = isGA(me?.position_name);

        // GA dapat menghapus kapan pun selama status < 5
        if (isGAUser) {
            if (Number(rows[0].status) >= 5) {
                return res.status(400).json({ message: "Pengajuan sudah diproses Finance, tidak bisa dihapus" });
            }
        } else {
            if (rows[0].employee_id !== employeeId) return res.status(403).json({ message: "Tidak diizinkan" });
            if (![1, 2, 9].includes(Number(rows[0].status))) {
                return res.status(400).json({ message: "Pengajuan pada status ini tidak bisa dihapus" });
            }
        }

        await safeQuery(`UPDATE tr_purchase_request SET is_deleted = 1, updated_at = NOW() WHERE pr_id = ?`, [id]);
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
        // Berlaku untuk pengajuan maupun reimburse
        if (jobLevel === 3) {
            if (pr.department_id !== me.department_id)
                return res.status(403).json({ message: "Hanya supervisor departemen terkait yang bisa approve" });
            if (Number(pr.status) !== 1)
                return res.status(400).json({ message: "Pengajuan ini tidak menunggu approval supervisor" });

            const spvNote = req.body.spv_note ? sanitize(req.body.spv_note) : null;

            // ── GA Tidak Rutin: SPV Dept approve → langsung status 4 (PR Ready) ──
            // karena GA sudah mengisi semua data, tidak perlu GA review lagi
            if (pr.is_routine === "tidak_rutin") {
                await safeQuery(
                    `UPDATE tr_purchase_request SET status = 4, approved_spv_by = ?, approved_spv_at = NOW(),
                        spv_note = ?, updated_at = NOW()
                     WHERE pr_id = ?`,
                    [employeeId, spvNote, id]
                );
                const logNote = spvNote
                    ? `Disetujui SPV Departemen | Catatan: ${spvNote} — PR langsung ready (GA tidak rutin)`
                    : "Disetujui SPV Departemen — PR langsung ready (GA tidak rutin)";
                await writeLog(id, "approved_spv", employeeId, me.full_name, logNote);
                return res.json({ message: "Pengajuan disetujui — PR siap diproses Finance" });
            }

            // Normal flow: status 1 → 2
            await safeQuery(
                `UPDATE tr_purchase_request SET status = 2, approved_spv_by = ?, approved_spv_at = NOW(), spv_note = ?, updated_at = NOW()
                 WHERE pr_id = ?`,
                [employeeId, spvNote, id]
            );
            const logNote = spvNote ? `Disetujui SPV Departemen | Catatan: ${spvNote}` : "Disetujui SPV Departemen";
            await writeLog(id, "approved_spv", employeeId, me.full_name, logNote);
            return res.json({ message: "Pengajuan disetujui" });
        }

        // Direktur (1) atau Manager (2) → approve status 2 → status 3
        // Hanya untuk pengajuan biasa (reimburse tidak melewati BoD manual)
        if (jobLevel === 1 || jobLevel === 2) {
            if (pr.type === "reimburse")
                return res.status(400).json({ message: "Reimburse tidak memerlukan approval Direktur manual" });
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
            // Direktur/Manager hanya bisa reject pengajuan biasa, bukan reimburse
            if (pr.type === "reimburse")
                return res.status(403).json({ message: "Reimburse tidak diproses oleh Direktur" });
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
        if (!canViewAllActivities(me)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA / BOD" });
        }

        const page   = Math.max(1, parseInt(req.query.page) || 1);
        const limit  = (req.query.limit === "all" || req.query.limit === "ALL")
            ? 999999
            : Math.min(100, parseInt(req.query.limit) || 20);
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

        const deptId = req.query.department_id ? Number(req.query.department_id) : null;
        if (deptId) {
            conditions.push("pr.department_id = ?");
            params.push(deptId);
        }

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
// LIST GA REVIEW  (GA — pengajuan yang perlu GA review)
// ════════════════════════════════════════════════════════════════════════════
// GA yang membuat sendiri sudah isi data langsung, jadi tidak muncul di sini.
// Hanya pengajuan dari NON-GA yang status 2 atau 3 dan butuh review GA.
export const listGaReview = async (req, res) => {
    try {
        const employeeId = getEmployeeId(req);
        if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

        const me = await fetchEmployee(employeeId);
        if (!me) return res.status(404).json({ message: "Employee tidak ditemukan" });
        if (!isGA(me.position_name)) {
            return res.status(403).json({ message: "Akses ditolak: hanya General Affair" });
        }

        const conditions = [
            "pr.is_deleted = 0",
            "pr.status IN (2, 3)",
            "pr.type = 'pengajuan'",
            "pr.employee_id != ?",
            "pr.is_routine IS NULL"
        ];
        const params = [employeeId];

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

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

        if (![2, 3, 4].includes(Number(pr.status))) {
            return res.status(400).json({ message: "Pengajuan belum disetujui Supervisor" });
        }

        // Jika status sudah 4 (fast-track), ini hanya update vendor info, bukan approval
        const isVendorUpdateOnly = Number(pr.status) === 4;

        // GA dapat override qty, merk, note
        const gaQty    = req.body.ga_qty    ? Number(req.body.ga_qty)            : Number(pr.qty);
        const gaMerk   = req.body.ga_merk   ? titleCase(sanitize(req.body.ga_merk)) : (pr.merk ? titleCase(pr.merk) : null);
        const gaNote   = req.body.ga_note   ? sanitize(req.body.ga_note)            : null;

        // Vendor mode: 'vendor', 'link', atau 'offline'
        const vendorMode = ["vendor", "link", "offline"].includes(req.body.vendor_mode) ? req.body.vendor_mode : null;
        if (!vendorMode) return res.status(400).json({ message: "Pilihan vendor/link/offline wajib diisi" });

        let vendorName = null;
        let vendorId   = null;
        let linkUrl    = null;
        let linkTitle  = null;

        if (vendorMode === "vendor") {
            vendorId   = req.body.vendor_id ? Number(req.body.vendor_id) : null;
            vendorName = req.body.vendor ? titleCase(sanitize(req.body.vendor)) : null;
            if (!vendorName && !vendorId) {
                return res.status(400).json({ message: "Nama vendor wajib diisi atau pilih dari daftar" });
            }
            if (vendorId && !vendorName) {
                const vRows = await safeQuery(`SELECT nama_vendor FROM mst_vendor WHERE id = ?`, [vendorId]);
                vendorName = vRows.length ? vRows[0].nama_vendor : null;
            }
        } else if (vendorMode === "link") {
            linkUrl   = req.body.link_url   ? sanitize(req.body.link_url)   : null;
            linkTitle = req.body.link_title  ? sanitize(req.body.link_title) : null;
            if (!linkUrl)   return res.status(400).json({ message: "Link URL wajib diisi" });
            if (!linkTitle) return res.status(400).json({ message: "Judul link wajib diisi" });
        } else if (vendorMode === "offline") {
            vendorName = sanitize(req.body.vendor);
            if (!vendorName) return res.status(400).json({ message: "Keterangan offline wajib diisi" });
        }

        if (isVendorUpdateOnly) {
            // Hanya update vendor info (status tetap 4)
            await safeQuery(
                `UPDATE tr_purchase_request SET
                    ga_qty = ?, ga_merk = ?, vendor = ?, vendor_mode = ?, vendor_id = ?,
                    link_url = ?, link_title = ?, ga_note = ?,
                    updated_at = NOW()
                 WHERE pr_id = ?`,
                [gaQty, gaMerk, vendorName, vendorMode, vendorId, linkUrl, linkTitle, gaNote, id]
            );
        } else {
            // Full GA approval: set status 4
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
        }

        const noteParts = [
            isVendorUpdateOnly ? "Info vendor dilengkapi" : "Disetujui GA",
            vendorMode === "vendor" ? `Vendor: ${vendorName}` : (vendorMode === "offline" ? `Offline: ${vendorName}` : `Link: ${linkTitle} (${linkUrl})`),
            gaQty   ? `Qty direvisi: ${gaQty}` : null,
            gaMerk  ? `Merk direvisi: ${gaMerk}` : null,
            gaNote  ? `Catatan: ${gaNote}` : null,
        ].filter(Boolean).join(" | ");

        await writeLog(id, isVendorUpdateOnly ? "vendor_updated" : "approved_ga", employeeId, me.full_name, noteParts);

        res.json({ message: isVendorUpdateOnly ? "Info vendor berhasil dilengkapi" : "Pengajuan disetujui GA — PO siap diterbitkan" });
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
        if (!canViewAllActivities(me)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA / BOD" });
        }

        const { id } = req.params;
        const rows = await safeQuery(
            `SELECT pr.*,
                    e.full_name AS pengaju_name, e.employee_code, e.job_level_id AS pengaju_job_level,
                    d.department_name,
                    s.satuan_name,
                    c.company_name,
                    c.address     AS company_address,
                    o.full_name AS outlet_name,
                    o.address     AS outlet_address,
                    bnk.bank_name,
                    spv_e.full_name  AS spv_name,
                    bod_e.full_name  AS bod_name,
                    ga_e.full_name   AS ga_name,
                    fin_e.full_name  AS finance_spv_name,
                    dir_e.full_name  AS director_name,
                    paid_e.full_name AS finance_staff_name,
                    paid_e.job_level_id AS finance_staff_job_level,
                    v.nama_vendor    AS vendor_nama_from_master,
                    v.alamat         AS vendor_alamat,
                    v.no_telepon_1   AS vendor_telepon
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e       ON e.employee_id     = pr.employee_id
             LEFT JOIN mst_department d       ON d.department_id   = pr.department_id
             LEFT JOIN mst_satuan     s       ON s.satuan_id       = pr.satuan_id
             LEFT JOIN mst_company    c       ON c.company_id      = pr.company_id
             LEFT JOIN mst_outlet     o       ON o.id              = pr.outlet_id
             LEFT JOIN mst_bank       bnk     ON bnk.bank_id       = pr.bank_id
             LEFT JOIN mst_employee   spv_e   ON spv_e.employee_id = pr.approved_spv_by
             LEFT JOIN mst_employee   bod_e   ON bod_e.employee_id = pr.approved_bod_by
             LEFT JOIN mst_employee   ga_e    ON ga_e.employee_id  = pr.approved_ga_by
             LEFT JOIN mst_employee   fin_e   ON fin_e.employee_id = pr.approved_finance_by
             LEFT JOIN mst_employee   dir_e   ON dir_e.employee_id = 2
             LEFT JOIN mst_employee   paid_e  ON paid_e.employee_id = pr.paid_by
             LEFT JOIN mst_vendor     v       ON v.id              = pr.vendor_id
             WHERE pr.pr_id = ? AND pr.is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });

        const pr = rows[0];
        // Reimburse: tersedia mulai status 2 (SPV Dept approved)
        // Pengajuan:  tersedia mulai status 2, PO mulai status 4
        const minStatus = 2;
        if (Number(pr.status) < minStatus || Number(pr.status) === 9) {
            return res.status(400).json({ message: "Dokumen belum tersedia pada status ini" });
        }

        res.json({ data: pr });
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

        const conditions = [
            "pr.is_deleted = 0",
            "((pr.type = 'pengajuan' AND pr.status = 4) OR (pr.type = 'reimburse' AND pr.status = 2))"
        ];
        const params = [];

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        // SPV Finance melihat:
        // - Pengajuan biasa: status 4 (sudah disetujui GA)
        // - Reimburse: status 2 (sudah disetujui SPV Departemen)
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
        const pr = rows[0];

        const finNote = req.body.finance_note ? sanitize(req.body.finance_note) : null;

        // ── REIMBURSE: status 2 → 5, BoD auto-approve bersamaan ─────────────
        if (pr.type === "reimburse") {
            if (Number(pr.status) !== 2) {
                return res.status(400).json({ message: "Reimburse belum disetujui SPV Departemen" });
            }
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
            const dirRows = await safeQuery(`SELECT full_name FROM mst_employee WHERE employee_id = 2 LIMIT 1`);
            const dirName = dirRows.length ? dirRows[0].full_name : "Direktur";
            await writeLog(id, "approved_bod", 2, dirName, "Disetujui BoD (otomatis bersamaan dengan SPV Finance)");
            return res.json({ message: "Reimburse disetujui SPV Finance — menunggu pembayaran" });
        }

        // ── PENGAJUAN BIASA: status 4 → 5 ────────────────────────────────────
        if (Number(pr.status) !== 4) {
            return res.status(400).json({ message: "Pengajuan belum disetujui GA" });
        }
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
            `SELECT status, type FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });

        const pr = rows[0];
        // Pengajuan biasa: tolak di status 4; Reimburse: tolak di status 2
        const validStatus = pr.type === "reimburse" ? [2] : [4];
        if (!validStatus.includes(Number(pr.status))) {
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

        const conditions = [
            "pr.is_deleted = 0",
            "pr.status = 5"
        ];
        const params = [];

        // ── filter tanggal (cutoff 26-25) ─────────────────────────────────
        const dateFrom = req.query.date_from?.trim() || "";
        const dateTo   = req.query.date_to?.trim()   || "";
        if (dateFrom) { conditions.push("pr.tanggal_pengajuan >= ?"); params.push(dateFrom); }
        if (dateTo)   { conditions.push("pr.tanggal_pengajuan <= ?"); params.push(dateTo); }

        const where = `WHERE ${conditions.join(" AND ")}`;

        // Finance melihat:
        // - Pengajuan biasa: status 5 (menunggu pembayaran)
        // - Reimburse: status 5 (disetujui SPV Finance, menunggu pembayaran)
        const data = await safeQuery(
            `SELECT pr.*, e.full_name AS pengaju_name, d.department_name,
                    s.satuan_name, c.company_name, o.full_name AS outlet_name,
                    bnk.bank_name
             FROM tr_purchase_request pr
             LEFT JOIN mst_employee   e   ON e.employee_id   = pr.employee_id
             LEFT JOIN mst_department d   ON d.department_id = pr.department_id
             LEFT JOIN mst_satuan     s   ON s.satuan_id     = pr.satuan_id
             LEFT JOIN mst_company    c   ON c.company_id    = pr.company_id
             LEFT JOIN mst_outlet     o   ON o.id            = pr.outlet_id
             LEFT JOIN mst_bank       bnk ON bnk.bank_id     = pr.bank_id
             ${where}
             ORDER BY pr.created_at ASC`,
            params
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
        const pr = rows[0];

        const expectedStatus = 5;
        if (Number(pr.status) !== expectedStatus) {
            return res.status(400).json({ message: "Pengajuan belum siap untuk pembayaran" });
        }

        const classificationId = req.body.classification_id ? Number(req.body.classification_id) : null;
        if (!classificationId) return res.status(400).json({ message: "Klasifikasi wajib dipilih" });

        let classificationName = "—";
        if (classificationId) {
            const [classRow] = await safeQuery(
                `SELECT classification_name FROM mst_purchase_classification WHERE id = ?`,
                [classificationId]
            );
            classificationName = classRow?.classification_name || "—";
        }

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
            const now = new Date();
            if (terminUnit === "hari")        now.setDate(now.getDate() + terminValue);
            else if (terminUnit === "bulan")  now.setMonth(now.getMonth() + terminValue);
            else if (terminUnit === "tahun")  now.setFullYear(now.getFullYear() + terminValue);
            jatuhTempo = now.toISOString().split("T")[0];
        }

        const paymentNote    = req.body.payment_note ? sanitize(req.body.payment_note) : null;
        const nominalBayarRaw = req.body.nominal_bayar ? Number(req.body.nominal_bayar) : null;
        const nominalBayar   = nominalBayarRaw || null;
        const adminFeeRaw    = req.body.admin_fee ? Number(req.body.admin_fee) : null;
        const adminFee       = adminFeeRaw || null;

        // Waktu pembayaran: gunakan yang dikirim frontend, fallback ke NOW() jika kosong
        const paidAtRaw = req.body.paid_at ? String(req.body.paid_at).trim() : null;
        // Validasi format datetime sederhana (YYYY-MM-DDTHH:mm atau YYYY-MM-DD HH:mm)
        const paidAtValue = paidAtRaw && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(paidAtRaw)
            ? paidAtRaw.replace("T", " ")  // MySQL-compatible: 'YYYY-MM-DD HH:mm'
            : null;
        // Untuk SQL: jika ada nilai, gunakan literal; jika tidak, gunakan NOW()
        // Kita pisah array params agar lebih fleksibel
        const paidAtSQL   = paidAtValue ? "?" : "NOW()";
        const paidAtParam = paidAtValue ? [paidAtValue] : [];
        // Sama untuk INSERT tr_purchase_request_payment
        const paidAtPaymentSQL   = paidAtValue ? "?" : "NOW()";
        const paidAtPaymentParam = paidAtValue ? [paidAtValue] : [];

        const files = req.files || [];
        if (!files.length) return res.status(400).json({ message: "Bukti pembayaran wajib dilampirkan" });
        const proofPath = `purchase/${files[0].filename}`;

        // ── REIMBURSE: status 5 → 7 (Selesai, finance yang menyelesaikan) ─────
        if (pr.type === "reimburse") {
            await safeQuery(
                `UPDATE tr_purchase_request SET
                    status = 7,
                    classification_id = ?,
                    payment_method = ?,
                    termin_value = ?, termin_unit = ?, jatuh_tempo = ?,
                    nominal_bayar = ?,
                    admin_fee = ?,
                    paid_by = ?, paid_at = ${paidAtSQL},
                    payment_proof_path = ?,
                    payment_note = ?,
                    completed_by = ?, completed_at = ${paidAtSQL},
                    invoice_proof_path = ?,
                    updated_at = NOW()
                 WHERE pr_id = ?`,
                [classificationId, paymentMethod, terminValue, terminUnit, jatuhTempo,
                 nominalBayar, adminFee, employeeId, ...paidAtParam, proofPath, paymentNote,
                 employeeId, ...paidAtParam, proofPath, id]
            );

            if (paymentMethod === "cash") {
                await safeQuery(
                    `INSERT INTO tr_purchase_request_payment
                        (pr_id, nominal_bayar, proof_path, note, paid_by, paid_by_name, paid_at)
                     VALUES (?, ?, ?, ?, ?, ?, ${paidAtPaymentSQL})`,
                    [id, nominalBayar || 0, proofPath, paymentNote, employeeId, me.full_name, ...paidAtPaymentParam]
                );
            }

            for (const f of files) {
                await safeQuery(
                    `INSERT INTO tr_purchase_request_attachment
                        (pr_id, file_path, original_name, mime_type, file_size_kb)
                     VALUES (?, ?, ?, ?, ?)`,
                    [id, `purchase/${f.filename}`, f.originalname, f.mimetype, Math.round(f.size / 1024)]
                );
            }

            const nominalLabel = nominalBayar
                ? ` | Nominal: Rp ${new Intl.NumberFormat("id-ID").format(nominalBayar)}`
                : "";
            const adminFeeLabel = adminFee
                ? ` | Biaya Admin: Rp ${new Intl.NumberFormat("id-ID").format(adminFee)}`
                : "";
            await writeLog(id, "paid", employeeId, me.full_name,
                `Pembayaran reimburse dilakukan | Metode: ${paymentMethod} | Klasifikasi: ${classificationName}${nominalLabel}${adminFeeLabel}${paymentNote ? ` | ${paymentNote}` : ""}`);
            await writeLog(id, "completed", employeeId, me.full_name,
                "Reimburse selesai — bukti pembayaran dilampirkan oleh Team Finance");

            return res.json({ message: "Pembayaran reimburse berhasil dicatat — reimburse selesai" });
        }

        // ── PENGAJUAN BIASA: status 5 → 6 ────────────────────────────────────
        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 6,
                classification_id = ?,
                payment_method = ?,
                termin_value = ?, termin_unit = ?, jatuh_tempo = ?,
                nominal_bayar = ?,
                admin_fee = ?,
                paid_by = ?, paid_at = ${paidAtSQL},
                payment_proof_path = ?,
                payment_note = ?,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [classificationId, paymentMethod, terminValue, terminUnit, jatuhTempo, nominalBayar, adminFee, employeeId, ...paidAtParam, proofPath, paymentNote, id]
        );

        if (paymentMethod === "cash") {
            await safeQuery(
                `INSERT INTO tr_purchase_request_payment
                    (pr_id, nominal_bayar, proof_path, note, paid_by, paid_by_name, paid_at)
                 VALUES (?, ?, ?, ?, ?, ?, ${paidAtPaymentSQL})`,
                [id, nominalBayar || 0, proofPath, paymentNote, employeeId, me.full_name, ...paidAtPaymentParam]
            );
        }

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
        const adminFeeLabel = adminFee
            ? ` | Biaya Admin: Rp ${new Intl.NumberFormat("id-ID").format(adminFee)}`
            : "";
        const noteText = `${paymentMethod === "kredit" ? "PR diterbitkan (Kredit)" : "Pembayaran dilakukan"} | Metode: ${paymentMethod} | Klasifikasi: ${classificationName}${terminLabel}${nominalLabel}${adminFeeLabel}${paymentNote ? ` | ${paymentNote}` : ""}`;
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
// REJECT PAYMENT  (Staff Finance — tolak status 5 saat bayar)
// ════════════════════════════════════════════════════════════════════════════
export const rejectPayment = async (req, res) => {
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
            `SELECT status, type FROM tr_purchase_request WHERE pr_id = ? AND is_deleted = 0`,
            [id]
        );
        if (!rows.length) return res.status(404).json({ message: "Data tidak ditemukan" });

        if (Number(rows[0].status) !== 5) {
            return res.status(400).json({ message: "Pengajuan tidak bisa ditolak pada status ini" });
        }

        await safeQuery(
            `UPDATE tr_purchase_request SET
                status = 9, rejected_by = ?, rejected_at = NOW(),
                rejection_reason = ?, updated_at = NOW()
             WHERE pr_id = ?`,
            [employeeId, reason, id]
        );
        await writeLog(id, "rejected_payment", employeeId, me.full_name, reason);

        res.json({ message: "Pembayaran ditolak oleh Staff Finance" });
    } catch (err) {
        console.error("[rejectPayment]", err);
        res.status(500).json({ message: "Gagal menolak pembayaran" });
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

export const updatePaymentInfo = async (req, res) => {
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

        if (Number(pr.status) < 6) {
            return res.status(400).json({ message: "Pengajuan belum dibayar" });
        }

        const classificationId = req.body.classification_id ? Number(req.body.classification_id) : null;
        if (!classificationId) return res.status(400).json({ message: "Klasifikasi wajib dipilih" });

        const paymentMethod = ["cash", "kredit"].includes(req.body.payment_method) ? req.body.payment_method : null;
        if (!paymentMethod) return res.status(400).json({ message: "Metode pembayaran wajib dipilih" });

        const nominalBayarRaw = req.body.nominal_bayar ? Number(req.body.nominal_bayar) : null;
        const nominalBayar   = nominalBayarRaw || null;
        if (!nominalBayar) return res.status(400).json({ message: "Nominal bayar wajib diisi" });

        const adminFeeRaw    = req.body.admin_fee ? Number(req.body.admin_fee) : null;
        const adminFee       = adminFeeRaw || null;

        // Fetch new classification name
        let classificationName = "—";
        if (classificationId) {
            const [classRow] = await safeQuery(
                `SELECT classification_name FROM mst_purchase_classification WHERE id = ?`,
                [classificationId]
            );
            classificationName = classRow?.classification_name || "—";
        }

        // Fetch old classification name
        let oldClassificationName = "—";
        if (pr.classification_id) {
            const [oldClassRow] = await safeQuery(
                `SELECT classification_name FROM mst_purchase_classification WHERE id = ?`,
                [pr.classification_id]
            );
            oldClassificationName = oldClassRow?.classification_name || "—";
        }

        const fmtRp = (n) => n ? `Rp ${new Intl.NumberFormat("id-ID").format(n)}` : "—";

        const oldNominal = fmtRp(pr.nominal_bayar);
        const newNominal = fmtRp(nominalBayar);
        const oldMethod = pr.payment_method || "—";
        const newMethod = paymentMethod;
        const oldAdmin = fmtRp(pr.admin_fee);
        const newAdmin = fmtRp(adminFee);

        await safeQuery(
            `UPDATE tr_purchase_request SET
                classification_id = ?,
                payment_method = ?,
                nominal_bayar = ?,
                admin_fee = ?,
                updated_at = NOW()
             WHERE pr_id = ?`,
            [classificationId, paymentMethod, nominalBayar, adminFee, id]
        );

        if (paymentMethod === "cash") {
            const payRows = await safeQuery(
                `SELECT payment_id FROM tr_purchase_request_payment WHERE pr_id = ? ORDER BY paid_at DESC LIMIT 1`,
                [id]
            );
            if (payRows.length) {
                await safeQuery(
                    `UPDATE tr_purchase_request_payment SET
                        nominal_bayar = ?,
                        paid_by = ?,
                        paid_by_name = ?
                     WHERE payment_id = ?`,
                    [nominalBayar, employeeId, me.full_name, payRows[0].payment_id]
                );
            } else {
                await safeQuery(
                    `INSERT INTO tr_purchase_request_payment
                        (pr_id, nominal_bayar, note, paid_by, paid_by_name, paid_at)
                     VALUES (?, ?, ?, ?, ?, NOW())`,
                    [id, nominalBayar, "Diubah ke Cash", employeeId, me.full_name]
                );
            }
        } else if (paymentMethod === "kredit") {
            await safeQuery(
                `DELETE FROM tr_purchase_request_payment WHERE pr_id = ?`,
                [id]
            );
        }

        const logMsg = `Info pembayaran diupdate oleh Finance | ` +
            `Nominal: ${oldNominal} -> ${newNominal} | ` +
            `Metode: ${oldMethod} -> ${newMethod} | ` +
            `Klasifikasi: ${oldClassificationName} -> ${classificationName} | ` +
            `Admin Fee: ${oldAdmin} -> ${newAdmin}`;
        await writeLog(id, "update_payment", employeeId, me.full_name, logMsg);

        res.json({ message: "Info pembayaran berhasil diupdate" });
    } catch (err) {
        console.error("[updatePaymentInfo]", err);
        res.status(500).json({ message: "Gagal mengupdate info pembayaran" });
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
        if (!canViewAllActivities(me)) {
            return res.status(403).json({ message: "Akses ditolak: hanya Finance / GA / BOD" });
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
