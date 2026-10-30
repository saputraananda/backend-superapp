import { pool, safeQuery } from "../../db/pool.js";

// ════════════════════════════════════════════════════════════════════════════
// MASTER CHART OF ACCOUNTS (tr_accounts)
// ════════════════════════════════════════════════════════════════════════════

// ── Inisialisasi Tabel Bagan Akun (tr_accounts) ─────────────────────────────
const initDb = async () => {
    try {
        await safeQuery(`
      CREATE TABLE IF NOT EXISTS tr_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        type ENUM('ASET', 'KEWAJIBAN', 'EKUITAS', 'PENDAPATAN', 'BEBAN') NOT NULL,
        normal_balance ENUM('DEBIT', 'KREDIT') NOT NULL,
        parent_id INT NULL,
        is_header TINYINT(1) NOT NULL DEFAULT 0,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        memo TEXT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tr_accounts_type (type),
        INDEX idx_tr_accounts_parent (parent_id),
        INDEX idx_tr_accounts_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    } catch (err) {
        console.error("❌ Failed to initialize tr_accounts table:", err.message);
    }
};
initDb();

/**
 * GET /finance-ho/accounts
 * Mengambil seluruh daftar akun COA dengan filter & search
 */


export async function getAccounts(req, res) {
    try {
        const { search = "", type = "", is_active = "" } = req.query;
        const conditions = ["1=1"];
        const params = [];

        if (search && search.trim()) {
            conditions.push("(a.code LIKE ? OR a.name LIKE ?)");
            const term = `%${search.trim()}%`;
            params.push(term, term);
        }

        if (type && type.trim()) {
            conditions.push("a.type = ?");
            params.push(type.trim());
        }

        if (is_active !== "" && is_active !== undefined) {
            conditions.push("a.is_active = ?");
            params.push(Number(is_active));
        }

        const whereSql = conditions.join(" AND ");

        const [rows] = await pool.query(
            `SELECT 
         a.id, 
         a.code, 
         a.name, 
         a.type, 
         a.normal_balance, 
         a.parent_id, 
         a.is_header, 
         a.is_active, 
         a.memo,
         p.name as parent_name,
         p.code as parent_code,
         COALESCE(bal.balance, 0) as balance
       FROM tr_accounts a
       LEFT JOIN tr_accounts p ON a.parent_id = p.id
       LEFT JOIN (
         SELECT 
           jl.account_id,
           SUM(CASE WHEN acc.normal_balance = 'DEBIT' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END) as balance
         FROM tr_journal_lines jl
         JOIN tr_journal_entries je ON jl.entry_id = je.id
         JOIN tr_accounts acc ON jl.account_id = acc.id
         WHERE je.status = 'POSTED'
         GROUP BY jl.account_id
       ) bal ON a.id = bal.account_id
       WHERE ${whereSql}
       ORDER BY a.code ASC`,
            params
        );

        return res.json({ data: rows });
    } catch (err) {
        console.error("[getAccounts] Error:", err);
        return res.status(500).json({ message: "Gagal mengambil daftar akun", error: err.message });
    }
}

/**
 * GET /finance-ho/accounts/select
 * Mengambil daftar akun aktif dan non-header untuk pilihan dropdown di form jurnal
 */
export async function getAccountsForSelect(req, res) {
    try {
        const [rows] = await pool.query(
            `SELECT id, code, name, type, normal_balance, is_header, is_active 
       FROM tr_accounts 
       WHERE (is_active IS NULL OR is_active = 1) 
         AND (is_header IS NULL OR is_header = 0)
       ORDER BY code ASC`
        );
        return res.json({ data: rows });
    } catch (err) {
        console.error("[getAccountsForSelect] Error:", err);
        return res.status(500).json({ message: "Gagal mengambil daftar akun", error: err.message });
    }
}

/**
 * POST /finance-ho/accounts
 * Menambahkan akun baru (dinamis, tersimpan di tr_accounts)
 */
export async function createAccount(req, res) {
    try {
        const { code, name, type, normal_balance, parent_id, is_header, memo } = req.body;
        const actorId = req.session?.userId || req.session?.employeeId || null;

        if (!code || !code.trim()) {
            return res.status(422).json({ code: "CODE_REQUIRED", message: "Kode akun wajib diisi." });
        }
        if (!name || !name.trim()) {
            return res.status(422).json({ code: "NAME_REQUIRED", message: "Nama akun wajib diisi." });
        }
        if (!type || !["ASET", "KEWAJIBAN", "EKUITAS", "PENDAPATAN", "BEBAN"].includes(type)) {
            return res.status(422).json({ code: "INVALID_TYPE", message: "Kategori akun tidak valid." });
        }

        // Default saldo normal otomatis jika tidak dipilih
        const defaultNormal = ["ASET", "BEBAN"].includes(type) ? "DEBIT" : "KREDIT";
        const normalBal = normal_balance === "DEBIT" || normal_balance === "KREDIT" ? normal_balance : defaultNormal;

        // Cek duplikasi kode akun
        const [existing] = await pool.query(
            `SELECT id FROM tr_accounts WHERE code = ?`,
            [code.trim()]
        );
        if (existing.length > 0) {
            return res.status(422).json({
                code: "DUPLICATE_CODE",
                message: `Kode akun "${code.trim()}" sudah digunakan.`,
            });
        }

        const [result] = await pool.query(
            `INSERT INTO tr_accounts 
         (code, name, type, normal_balance, parent_id, is_header, is_active, memo, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
                code.trim(),
                name.trim(),
                type,
                normalBal,
                parent_id ? Number(parent_id) : null,
                is_header ? 1 : 0,
                memo ? memo.trim() : null,
                actorId,
            ]
        );

        const newId = result.insertId;

        // Catat ke audit log
        try {
            await pool.query(
                `INSERT INTO tr_audit_logs (entity, entity_id, action, actor_id, after_value)
         VALUES ('tr_accounts', ?, 'CREATE', ?, ?)`,
                [
                    newId,
                    actorId,
                    JSON.stringify({ code: code.trim(), name: name.trim(), type, normal_balance: normalBal }),
                ]
            );
        } catch (auditErr) {
            console.warn("[createAccount] Audit log error:", auditErr.message);
        }

        const [newAcc] = await pool.query(
            `SELECT id, code, name, type, normal_balance, is_header, is_active, memo
       FROM tr_accounts WHERE id = ?`,
            [newId]
        );

        return res.status(201).json({
            message: "Akun berhasil dibuat.",
            data: newAcc[0],
        });
    } catch (err) {
        console.error("[createAccount] Error:", err);
        return res.status(500).json({ message: "Gagal membuat akun", error: err.message });
    }
}

/**
 * PUT /finance-ho/accounts/:id
 * Mengupdate data akun
 */
export async function updateAccount(req, res) {
    try {
        const { id } = req.params;
        const { code, name, type, normal_balance, parent_id, is_header, is_active, memo } = req.body;

        const [existing] = await pool.query(`SELECT * FROM tr_accounts WHERE id = ?`, [id]);
        if (existing.length === 0) {
            return res.status(404).json({ message: "Akun tidak ditemukan." });
        }
        const current = existing[0];

        if (code && code.trim() !== current.code) {
            const [dup] = await pool.query(`SELECT id FROM tr_accounts WHERE code = ? AND id != ?`, [code.trim(), id]);
            if (dup.length > 0) {
                return res.status(422).json({ code: "DUPLICATE_CODE", message: `Kode akun "${code.trim()}" sudah digunakan.` });
            }
        }

        const newCode = code ? code.trim() : current.code;
        const newName = name ? name.trim() : current.name;
        const newType = type || current.type;
        const newNormal = normal_balance || current.normal_balance;
        const newParent = parent_id !== undefined ? (parent_id ? Number(parent_id) : null) : current.parent_id;
        const newIsHeader = is_header !== undefined ? (is_header ? 1 : 0) : current.is_header;
        const newIsActive = is_active !== undefined ? (is_active ? 1 : 0) : current.is_active;
        const newMemo = memo !== undefined ? (memo ? memo.trim() : null) : current.memo;

        await pool.query(
            `UPDATE tr_accounts 
       SET code = ?, name = ?, type = ?, normal_balance = ?, parent_id = ?, is_header = ?, is_active = ?, memo = ?
       WHERE id = ?`,
            [newCode, newName, newType, newNormal, newParent, newIsHeader, newIsActive, newMemo, id]
        );

        return res.json({ message: "Akun berhasil diperbarui." });
    } catch (err) {
        console.error("[updateAccount] Error:", err);
        return res.status(500).json({ message: "Gagal memperbarui akun", error: err.message });
    }
}

/**
 * POST /finance-ho/accounts/seed-default
 * Mengisi akun COA standar jika tabel masih kosong
 */
export async function seedDefaultAccounts(req, res) {
    try {
        const [cnt] = await pool.query(`SELECT COUNT(*) as c FROM tr_accounts`);
        if (cnt[0].c > 0) {
            return res.status(400).json({ message: "Tabel akun sudah memiliki data." });
        }
        // hardcode
        const defaultList = [
            // ASET
            { code: "1-1001", name: "Kas Kecil", type: "ASET", normal_balance: "DEBIT" },
            { code: "1-1002", name: "Kas Operasional", type: "ASET", normal_balance: "DEBIT" },
            { code: "1-1003", name: "Bank BCA", type: "ASET", normal_balance: "DEBIT" },
            { code: "1-1004", name: "Bank Mandiri", type: "ASET", normal_balance: "DEBIT" },
            { code: "1-1005", name: "Piutang Usaha", type: "ASET", normal_balance: "DEBIT" },
            { code: "1-1006", name: "Perlengkapan Operasional", type: "ASET", normal_balance: "DEBIT" },
            // KEWAJIBAN
            { code: "2-1001", name: "Utang Usaha", type: "KEWAJIBAN", normal_balance: "KREDIT" },
            { code: "2-1002", name: "Utang Gaji", type: "KEWAJIBAN", normal_balance: "KREDIT" },
            { code: "2-1003", name: "Utang Pajak", type: "KEWAJIBAN", normal_balance: "KREDIT" },
            // EKUITAS
            { code: "3-1001", name: "Modal Disetor", type: "EKUITAS", normal_balance: "KREDIT" },
            { code: "3-1002", name: "Laba Ditahan", type: "EKUITAS", normal_balance: "KREDIT" },
            // PENDAPATAN
            { code: "4-1001", name: "Pendapatan Layanan Laundry", type: "PENDAPATAN", normal_balance: "KREDIT" },
            { code: "4-1002", name: "Pendapatan B2B & Kemitraan", type: "PENDAPATAN", normal_balance: "KREDIT" },
            { code: "4-1003", name: "Pendapatan Lain-lain", type: "PENDAPATAN", normal_balance: "KREDIT" },
            // BEBAN
            { code: "5-1001", name: "Beban Gaji & Upah", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1002", name: "Beban Listrik, Air & Gas", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1003", name: "Beban Deterjen & Kimia", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1004", name: "Beban Sewa Tempat", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1005", name: "Beban Perawatan Mesin", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1006", name: "Beban Transportasi & Pengiriman", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1007", name: "Beban Pemasaran & Promosi", type: "BEBAN", normal_balance: "DEBIT" },
            { code: "5-1008", name: "Beban Administrasi & Umum", type: "BEBAN", normal_balance: "DEBIT" },
        ];

        for (const a of defaultList) {
            await pool.query(
                `INSERT INTO tr_accounts (code, name, type, normal_balance, is_header, is_active)
         VALUES (?, ?, ?, ?, 0, 1)`,
                [a.code, a.name, a.type, a.normal_balance]
            );
        }

        return res.status(201).json({ message: "21 akun standar berhasil dimuat ke database." });
    } catch (err) {
        console.error("[seedDefaultAccounts] Error:", err);
        return res.status(500).json({ message: "Gagal memuat akun standar", error: err.message });
    }
}
