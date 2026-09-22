// ════════════════════════════════════════════════════════════════════════════
// MASTER KLASIFIKASI PEMBELIAN (mst_purchase_classification)
// CRUD — khusus Tim Finance.
// ════════════════════════════════════════════════════════════════════════════

import { pool } from "../../db/pool.js";

const safeQuery = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

const getEmployeeId = (req) =>
    req.session?.employeeId ?? req.session?.employee_id ?? null;

const sanitize = (str) => {
    if (str == null) return null;
    return String(str)
        .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
        .replace(/<[^>]*>/g, "")
        .trim();
};

const titleCase = (str) => {
    if (str == null) return null;
    return String(str).toLowerCase().replace(/(?:^|\s+)\S/g, (c) => c.toUpperCase()).trim();
};

const isFinance = (positionName) => {
    if (!positionName) return false;
    const pos = String(positionName).toLowerCase();
    return pos.includes("finance") || pos.includes("accounting") || pos.includes("accountiing");
};

// Guard: semua endpoint di file ini hanya untuk Finance.
const requireFinance = async (req, res) => {
    const employeeId = getEmployeeId(req);
    if (!employeeId) {
        res.status(401).json({ message: "Unauthorized" });
        return null;
    }
    const rows = await safeQuery(
        `SELECT e.employee_id, e.full_name, p.position_name
         FROM mst_employee e
         LEFT JOIN mst_position p ON p.position_id = e.position_id
         WHERE e.employee_id = ? AND e.is_deleted = 0 LIMIT 1`,
        [employeeId]
    );
    const me = rows[0];
    if (!me || !isFinance(me.position_name)) {
        res.status(403).json({ message: "Akses ditolak: hanya Tim Finance" });
        return null;
    }
    return me;
};

const validName = (raw) => {
    const name = titleCase(sanitize(raw));
    if (!name || name.length < 2 || name.length > 100) return null;
    return name;
};

// ── LIST ────────────────────────────────────────────────────────────────────
export const listClassifications = async (req, res) => {
    try {
        if (!(await requireFinance(req, res))) return;

        const search = req.query.search?.trim() || "";
        const params = [];
        let where = "1 = 1";
        if (search) {
            where += " AND c.classification_name LIKE ?";
            params.push(`%${search}%`);
        }

        const data = await safeQuery(
            `SELECT c.id, c.classification_name, c.is_active,
                    (SELECT COUNT(*) FROM tr_purchase_request_classification prc
                     WHERE prc.classification_id = c.id) AS usage_count
             FROM mst_purchase_classification c
             WHERE ${where}
             ORDER BY c.is_active DESC, c.classification_name`,
            params
        );
        res.json({ data });
    } catch (err) {
        console.error("[listClassifications]", err);
        res.status(500).json({ message: "Gagal memuat klasifikasi" });
    }
};

// ── CREATE ──────────────────────────────────────────────────────────────────
export const createClassificationMaster = async (req, res) => {
    try {
        if (!(await requireFinance(req, res))) return;

        const name = validName(req.body.classification_name);
        if (!name) return res.status(400).json({ message: "Nama klasifikasi tidak valid (2–100 karakter)" });

        const exist = await safeQuery(
            `SELECT id, is_active FROM mst_purchase_classification
             WHERE LOWER(TRIM(classification_name)) = LOWER(?) LIMIT 1`,
            [name]
        );
        if (exist.length) {
            if (Number(exist[0].is_active)) {
                return res.status(409).json({ message: "Klasifikasi dengan nama tersebut sudah ada" });
            }
            // nama sama tapi nonaktif → aktifkan kembali
            await safeQuery(`UPDATE mst_purchase_classification SET is_active = 1 WHERE id = ?`, [exist[0].id]);
            return res.json({ data: { id: exist[0].id, classification_name: name }, message: "Klasifikasi diaktifkan kembali" });
        }

        const ins = await safeQuery(
            `INSERT INTO mst_purchase_classification (classification_name, is_active) VALUES (?, 1)`,
            [name]
        );
        res.status(201).json({ data: { id: ins.insertId, classification_name: name }, message: "Klasifikasi ditambahkan" });
    } catch (err) {
        console.error("[createClassificationMaster]", err);
        res.status(500).json({ message: "Gagal menambah klasifikasi" });
    }
};

// ── UPDATE (nama & status aktif) ────────────────────────────────────────────
export const updateClassificationMaster = async (req, res) => {
    try {
        if (!(await requireFinance(req, res))) return;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "ID tidak valid" });

        const rows = await safeQuery(`SELECT id FROM mst_purchase_classification WHERE id = ? LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ message: "Klasifikasi tidak ditemukan" });

        const name = validName(req.body.classification_name);
        if (!name) return res.status(400).json({ message: "Nama klasifikasi tidak valid (2–100 karakter)" });

        const dup = await safeQuery(
            `SELECT id FROM mst_purchase_classification
             WHERE LOWER(TRIM(classification_name)) = LOWER(?) AND id <> ? LIMIT 1`,
            [name, id]
        );
        if (dup.length) return res.status(409).json({ message: "Nama klasifikasi sudah dipakai" });

        const isActive = req.body.is_active == null
            ? null
            : (String(req.body.is_active) === "0" ? 0 : 1);

        await safeQuery(
            `UPDATE mst_purchase_classification
             SET classification_name = ?${isActive == null ? "" : ", is_active = ?"}
             WHERE id = ?`,
            isActive == null ? [name, id] : [name, isActive, id]
        );

        res.json({ message: "Klasifikasi diperbarui" });
    } catch (err) {
        console.error("[updateClassificationMaster]", err);
        res.status(500).json({ message: "Gagal memperbarui klasifikasi" });
    }
};

// ── DELETE ──────────────────────────────────────────────────────────────────
// Masih dipakai pengajuan → nonaktifkan (soft). Belum pernah dipakai → hapus.
export const deleteClassificationMaster = async (req, res) => {
    try {
        if (!(await requireFinance(req, res))) return;

        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: "ID tidak valid" });

        const rows = await safeQuery(`SELECT id FROM mst_purchase_classification WHERE id = ? LIMIT 1`, [id]);
        if (!rows.length) return res.status(404).json({ message: "Klasifikasi tidak ditemukan" });

        const used = await safeQuery(
            `SELECT COUNT(*) AS total FROM tr_purchase_request_classification WHERE classification_id = ?`,
            [id]
        );
        if (Number(used[0].total) > 0) {
            await safeQuery(`UPDATE mst_purchase_classification SET is_active = 0 WHERE id = ?`, [id]);
            return res.json({
                message: `Klasifikasi dipakai ${used[0].total} pengajuan — dinonaktifkan, bukan dihapus`,
                deactivated: true,
            });
        }

        await safeQuery(`DELETE FROM mst_purchase_classification WHERE id = ?`, [id]);
        res.json({ message: "Klasifikasi dihapus", deactivated: false });
    } catch (err) {
        console.error("[deleteClassificationMaster]", err);
        res.status(500).json({ message: "Gagal menghapus klasifikasi" });
    }
};
