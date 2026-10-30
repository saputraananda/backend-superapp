import { pool, safeQuery } from "../../db/pool.js";

// ── Initialize Tables (Auto-migration sesuai konvensi backend) ─────────
const initDb = async () => {
  try {
    // 1. Master Accounts (Chart of Accounts)
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

    // 2. Header Jurnal Umum (Journal Entries)
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS tr_journal_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_no VARCHAR(50) NOT NULL UNIQUE,
        entry_date DATE NOT NULL,
        description TEXT NOT NULL,
        status ENUM('POSTED', 'REVERSED') NOT NULL DEFAULT 'POSTED',
        total_amount DECIMAL(18,2) NOT NULL DEFAULT 0.00,
        reverses_entry_id INT NULL,
        reversed_by_entry_id INT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tr_journal_entry_date (entry_date),
        INDEX idx_tr_journal_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 3. Baris Jurnal (Journal Lines)
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS tr_journal_lines (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_id INT NOT NULL,
        line_no INT NOT NULL,
        account_id INT NOT NULL,
        debit DECIMAL(18,2) NOT NULL DEFAULT 0.00,
        credit DECIMAL(18,2) NOT NULL DEFAULT 0.00,
        memo TEXT NULL,
        INDEX idx_tr_jlines_entry_id (entry_id),
        INDEX idx_tr_jlines_account_id (account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 4. Tabel Anggaran (Budgets)
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS tr_budgets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account_id INT NOT NULL,
        period DATE NOT NULL,
        amount DECIMAL(18,2) NOT NULL DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_tr_account_period (account_id, period)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 5. Tabel Audit Logs
    await safeQuery(`
      CREATE TABLE IF NOT EXISTS tr_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entity VARCHAR(50) NOT NULL,
        entity_id INT NOT NULL,
        action ENUM('CREATE', 'UPDATE', 'DEACTIVATE', 'REVERSE') NOT NULL,
        actor_id INT NULL,
        changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        before_value JSON NULL,
        after_value JSON NULL,
        INDEX idx_tr_audit_entity (entity, entity_id),
        INDEX idx_tr_audit_actor (actor_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (err) {
    console.error("❌ Failed to initialize Finance HO tables:", err.message);
  }
};
initDb();

// Helper round Rupiah 2 decimal
function toFixed2(val) {
  const num = Number(val) || 0;
  return Math.round(num * 100) / 100;
}

// Helper format Rupiah untuk error message
function formatRupiah(num) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(num);
}

// ════════════════════════════════════════════════════════════════════════════
// MASTER CHART OF ACCOUNTS (tr_accounts)
// ════════════════════════════════════════════════════════════════════════════

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
         p.code as parent_code
       FROM tr_accounts a
       LEFT JOIN tr_accounts p ON a.parent_id = p.id
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

// ════════════════════════════════════════════════════════════════════════════
// TRANSAKSI JURNAL UMUM (tr_journal_entries & tr_journal_lines)
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /finance-ho/journals
 * Mengambil daftar jurnal umum dengan paginasi dan filter
 */
export async function getJournals(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const { q = "", from = "", to = "", status = "" } = req.query;

    const conditions = ["1=1"];
    const params = [];

    if (q && q.trim()) {
      conditions.push("(je.entry_no LIKE ? OR je.description LIKE ?)");
      const term = `%${q.trim()}%`;
      params.push(term, term);
    }

    if (from) {
      conditions.push("je.entry_date >= ?");
      params.push(from);
    }

    if (to) {
      conditions.push("je.entry_date <= ?");
      params.push(to);
    }

    if (status) {
      conditions.push("je.status = ?");
      params.push(status);
    }

    const whereSql = conditions.join(" AND ");

    // Hitung total
    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total FROM tr_journal_entries je WHERE ${whereSql}`,
      params
    );
    const total = countRows[0]?.total || 0;

    // Ambil data
    const [dataRows] = await pool.query(
      `SELECT 
         je.id,
         je.entry_no,
         DATE_FORMAT(je.entry_date, '%Y-%m-%d') as entry_date,
         je.description,
         je.status,
         je.total_amount,
         je.reverses_entry_id,
         je.reversed_by_entry_id,
         je.created_by,
         je.created_at,
         u.name as creator_name
       FROM tr_journal_entries je
       LEFT JOIN users u ON je.created_by = u.id
       WHERE ${whereSql}
       ORDER BY je.entry_date DESC, je.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      data: dataRows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    console.error("[getJournals] Error:", err);
    return res.status(500).json({ message: "Gagal mengambil daftar jurnal", error: err.message });
  }
}

/**
 * GET /finance-ho/journals/:id
 * Mengambil detail jurnal beserta baris-baris debit dan kreditnya
 */
export async function getJournalDetail(req, res) {
  try {
    const { id } = req.params;

    const [headerRows] = await pool.query(
      `SELECT 
         je.id,
         je.entry_no,
         DATE_FORMAT(je.entry_date, '%Y-%m-%d') as entry_date,
         je.description,
         je.status,
         je.total_amount,
         je.reverses_entry_id,
         je.reversed_by_entry_id,
         je.created_by,
         je.created_at,
         u.name as creator_name,
         rev_from.entry_no as reverses_entry_no,
         rev_by.entry_no as reversed_by_entry_no
       FROM tr_journal_entries je
       LEFT JOIN users u ON je.created_by = u.id
       LEFT JOIN tr_journal_entries rev_from ON je.reverses_entry_id = rev_from.id
       LEFT JOIN tr_journal_entries rev_by ON je.reversed_by_entry_id = rev_by.id
       WHERE je.id = ?`,
      [id]
    );

    if (headerRows.length === 0) {
      return res.status(404).json({ message: "Jurnal tidak ditemukan" });
    }

    const journal = headerRows[0];

    // Ambil baris jurnal
    const [lineRows] = await pool.query(
      `SELECT 
         jl.id,
         jl.line_no,
         jl.account_id,
         jl.debit,
         jl.credit,
         jl.memo,
         a.code as account_code,
         a.name as account_name,
         a.type as account_type,
         a.normal_balance
       FROM tr_journal_lines jl
       LEFT JOIN tr_accounts a ON jl.account_id = a.id
       WHERE jl.entry_id = ?
       ORDER BY jl.line_no ASC`,
      [id]
    );

    journal.lines = lineRows;

    return res.json({ data: journal });
  } catch (err) {
    console.error("[getJournalDetail] Error:", err);
    return res.status(500).json({ message: "Gagal mengambil detail jurnal", error: err.message });
  }
}

/**
 * POST /finance-ho/journals
 * Membuat jurnal umum baru (Atomik, Double-entry balanced validation)
 */
export async function createJournal(req, res) {
  const conn = await pool.getConnection();

  try {
    const { entry_date, description, lines } = req.body;
    const actorId = req.session?.userId || req.session?.employeeId || null;

    // 1. Validasi Header
    if (!entry_date) {
      return res.status(422).json({
        code: "INVALID_DATE",
        message: "Tanggal jurnal wajib diisi.",
      });
    }

    if (!description || !description.trim()) {
      return res.status(422).json({
        code: "INVALID_DESCRIPTION",
        message: "Deskripsi jurnal wajib diisi.",
      });
    }

    // 2. Validasi Array Baris
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(422).json({
        code: "JOURNAL_MIN_LINES",
        message: "Jurnal minimal harus memiliki 2 baris transaksi bernominal.",
      });
    }

    // Filter baris yang punya nominal debit atau kredit
    const activeLines = lines.filter((l) => {
      const d = toFixed2(l.debit);
      const c = toFixed2(l.credit);
      return d > 0 || c > 0 || Boolean(l.account_id);
    });

    if (activeLines.length < 2) {
      return res.status(422).json({
        code: "JOURNAL_MIN_LINES",
        message: "Jurnal minimal harus memiliki 2 baris transaksi bernominal.",
      });
    }

    let totalDebit = 0;
    let totalCredit = 0;
    const accountIds = [];

    // Periksa validitas setiap baris
    for (let i = 0; i < activeLines.length; i++) {
      const line = activeLines[i];
      const d = toFixed2(line.debit);
      const c = toFixed2(line.credit);

      if (!line.account_id) {
        return res.status(422).json({
          code: "ACCOUNT_REQUIRED",
          message: `Baris ke-${i + 1} belum memilih akun yang valid.`,
        });
      }

      // Aturan: Tepat satu dari debit atau credit > 0, tidak keduanya dan tidak nol semua
      if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
        return res.status(422).json({
          code: "LINE_DEBIT_AND_CREDIT",
          message: `Baris ke-${i + 1} harus mengisi salah satu: debit atau kredit (tidak boleh keduanya dan tidak boleh nol).`,
        });
      }

      if (d < 0 || c < 0) {
        return res.status(422).json({
          code: "NEGATIVE_AMOUNT",
          message: `Baris ke-${i + 1} tidak boleh bernilai negatif.`,
        });
      }

      totalDebit += d;
      totalCredit += c;
      accountIds.push(line.account_id);
    }

    totalDebit = toFixed2(totalDebit);
    totalCredit = toFixed2(totalCredit);

    // 3. Validasi Seimbang (Balanced)
    const diff = toFixed2(Math.abs(totalDebit - totalCredit));
    if (diff > 0.001 || totalDebit <= 0) {
      const direction = totalDebit < totalCredit ? "Debit kurang" : "Kredit kurang";
      return res.status(422).json({
        code: "JOURNAL_NOT_BALANCED",
        message: `Total debit (${formatRupiah(totalDebit)}) tidak sama dengan kredit (${formatRupiah(totalCredit)}). Selisih: ${formatRupiah(diff)} (${direction}).`,
        totalDebit,
        totalCredit,
        difference: diff,
      });
    }

    // 4. Validasi Akun di Database tr_accounts (Konversi ke Number agar perbandingan Map aman)
    const uniqueAccountIds = [...new Set(accountIds.map((id) => Number(id)))];
    const [accRows] = await pool.query(
      `SELECT id, code, name, is_header, is_active FROM tr_accounts WHERE id IN (?)`,
      [uniqueAccountIds]
    );

    const accMap = new Map();
    accRows.forEach((a) => accMap.set(Number(a.id), a));

    for (const accId of uniqueAccountIds) {
      const acc = accMap.get(Number(accId));
      if (!acc) {
        return res.status(422).json({
          code: "ACCOUNT_NOT_FOUND",
          message: `Akun finansial (COA) dengan ID ${accId} tidak ditemukan di daftar akun.`,
        });
      }
      if (acc.is_active === 0) {
        return res.status(422).json({
          code: "ACCOUNT_INACTIVE",
          message: `Akun "${acc.code} - ${acc.name}" dalam status nonaktif dan tidak bisa digunakan di jurnal.`,
        });
      }
      if (acc.is_header === 1) {
        return res.status(422).json({
          code: "ACCOUNT_IS_HEADER",
          message: `Akun "${acc.code} - ${acc.name}" adalah akun induk/header dan tidak bisa digunakan untuk transaksi.`,
        });
      }
    }

    // 5. Mulai Transaksi Database Atomik
    await conn.beginTransaction();

    // 6. Generate Nomor Jurnal Otomatis JU-YYYY-MM-NNNN (dengan Lock FOR UPDATE)
    const dObj = new Date(entry_date);
    const yearStr = dObj.getFullYear();
    const monthStr = String(dObj.getMonth() + 1).padStart(2, "0");
    const prefix = `JU-${yearStr}-${monthStr}-`;

    const [lastRows] = await conn.query(
      `SELECT entry_no FROM tr_journal_entries 
       WHERE entry_no LIKE ? 
       ORDER BY entry_no DESC 
       LIMIT 1 FOR UPDATE`,
      [`${prefix}%`]
    );

    let nextSeq = 1;
    if (lastRows.length > 0) {
      const lastNo = lastRows[0].entry_no;
      const parts = lastNo.split("-");
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) {
        nextSeq = lastSeq + 1;
      }
    }

    const entry_no = `${prefix}${String(nextSeq).padStart(4, "0")}`;

    // 7. Simpan Header Jurnal
    const [headerResult] = await conn.query(
      `INSERT INTO tr_journal_entries 
         (entry_no, entry_date, description, status, total_amount, created_by)
       VALUES (?, ?, ?, 'POSTED', ?, ?)`,
      [entry_no, entry_date, description.trim(), totalDebit, actorId]
    );

    const entryId = headerResult.insertId;

    // 8. Simpan Baris Jurnal
    for (let idx = 0; idx < activeLines.length; idx++) {
      const line = activeLines[idx];
      const d = toFixed2(line.debit);
      const c = toFixed2(line.credit);
      const memo = line.memo ? line.memo.trim() : null;

      await conn.query(
        `INSERT INTO tr_journal_lines 
           (entry_id, line_no, account_id, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [entryId, idx + 1, Number(line.account_id), d, c, memo]
      );
    }

    // 9. Catat ke Audit Log
    try {
      await conn.query(
        `INSERT INTO tr_audit_logs 
           (entity, entity_id, action, actor_id, after_value)
         VALUES ('tr_journal_entries', ?, 'CREATE', ?, ?)`,
        [
          entryId,
          actorId,
          JSON.stringify({
            entry_no,
            entry_date,
            description: description.trim(),
            total_amount: totalDebit,
            lines_count: activeLines.length,
          }),
        ]
      );
    } catch (auditErr) {
      console.warn("[createJournal] Gagal mencatat audit log (lanjut):", auditErr.message);
    }

    await conn.commit();

    return res.status(201).json({
      message: "Jurnal berhasil disimpan.",
      entry_no,
      id: entryId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("[createJournal] Error:", err);
    return res.status(500).json({ message: "Gagal menyimpan jurnal", error: err.message });
  } finally {
    conn.release();
  }
}

/**
 * POST /finance-ho/journals/:id/reverse
 * Membuat Jurnal Pembalik (Reversal Entry)
 */
export async function reverseJournal(req, res) {
  const conn = await pool.getConnection();

  try {
    const { id } = req.params;
    const { entry_date } = req.body;
    const actorId = req.session?.userId || req.session?.employeeId || null;

    if (!entry_date) {
      return res.status(422).json({
        code: "INVALID_DATE",
        message: "Tanggal jurnal pembalik wajib diisi.",
      });
    }

    await conn.beginTransaction();

    // 1. Lock jurnal asal
    const [origRows] = await conn.query(
      `SELECT * FROM tr_journal_entries WHERE id = ? FOR UPDATE`,
      [id]
    );

    if (origRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Jurnal asal tidak ditemukan." });
    }

    const orig = origRows[0];

    // Aturan 6: Jurnal yang sudah dibalik tidak bisa dibalik lagi
    if (orig.status === "REVERSED" || orig.reversed_by_entry_id) {
      await conn.rollback();
      return res.status(422).json({
        code: "JOURNAL_ALREADY_REVERSED",
        message: "Jurnal ini sudah pernah dibalik sebelumnya.",
      });
    }

    // 2. Ambil baris jurnal asal
    const [origLines] = await conn.query(
      `SELECT * FROM tr_journal_lines WHERE entry_id = ? ORDER BY line_no ASC`,
      [id]
    );

    if (origLines.length === 0) {
      await conn.rollback();
      return res.status(422).json({
        code: "EMPTY_JOURNAL",
        message: "Jurnal asal tidak memiliki baris transaksi.",
      });
    }

    // 3. Generate nomor jurnal pembalik
    const dObj = new Date(entry_date);
    const yearStr = dObj.getFullYear();
    const monthStr = String(dObj.getMonth() + 1).padStart(2, "0");
    const prefix = `JU-${yearStr}-${monthStr}-`;

    const [lastRows] = await conn.query(
      `SELECT entry_no FROM tr_journal_entries 
       WHERE entry_no LIKE ? 
       ORDER BY entry_no DESC 
       LIMIT 1 FOR UPDATE`,
      [`${prefix}%`]
    );

    let nextSeq = 1;
    if (lastRows.length > 0) {
      const lastNo = lastRows[0].entry_no;
      const parts = lastNo.split("-");
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) nextSeq = lastSeq + 1;
    }

    const reverseEntryNo = `${prefix}${String(nextSeq).padStart(4, "0")}`;
    const reverseDesc = `Pembalik ${orig.entry_no}: ${orig.description}`;

    // 4. Insert header jurnal pembalik
    const [revHeaderResult] = await conn.query(
      `INSERT INTO tr_journal_entries 
         (entry_no, entry_date, description, status, total_amount, reverses_entry_id, created_by)
       VALUES (?, ?, ?, 'POSTED', ?, ?, ?)`,
      [reverseEntryNo, entry_date, reverseDesc, orig.total_amount, orig.id, actorId]
    );

    const reverseEntryId = revHeaderResult.insertId;

    // 5. Insert baris pembalik dengan membalik DEBIT dan KREDIT
    for (let i = 0; i < origLines.length; i++) {
      const line = origLines[i];
      // Tukar posisi: debit menjadi kredit, kredit menjadi debit
      const newDebit = line.credit;
      const newCredit = line.debit;
      const memo = line.memo ? `[Pembalik] ${line.memo}` : `Pembalik baris ${line.line_no}`;

      await conn.query(
        `INSERT INTO tr_journal_lines 
           (entry_id, line_no, account_id, debit, credit, memo)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [reverseEntryId, i + 1, Number(line.account_id), newDebit, newCredit, memo]
      );
    }

    // 6. Update status jurnal asal menjadi REVERSED
    await conn.query(
      `UPDATE tr_journal_entries 
       SET status = 'REVERSED', reversed_by_entry_id = ? 
       WHERE id = ?`,
      [reverseEntryId, orig.id]
    );

    // 7. Catat ke Audit Log
    try {
      await conn.query(
        `INSERT INTO tr_audit_logs 
           (entity, entity_id, action, actor_id, before_value, after_value)
         VALUES ('tr_journal_entries', ?, 'REVERSE', ?, ?, ?)`,
        [
          orig.id,
          actorId,
          JSON.stringify({ status: orig.status, reversed_by_entry_id: null }),
          JSON.stringify({ status: "REVERSED", reversed_by_entry_id: reverseEntryId }),
        ]
      );
    } catch (auditErr) {
      console.warn("[reverseJournal] Gagal mencatat audit log:", auditErr.message);
    }

    await conn.commit();

    return res.status(201).json({
      message: `Jurnal ${orig.entry_no} berhasil dibalik dengan nomor pembalik ${reverseEntryNo}.`,
      reversal_entry_no: reverseEntryNo,
      reversal_id: reverseEntryId,
    });
  } catch (err) {
    await conn.rollback();
    console.error("[reverseJournal] Error:", err);
    return res.status(500).json({ message: "Gagal membalik jurnal", error: err.message });
  } finally {
    conn.release();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BUKU BESAR / GENERAL LEDGER
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /finance-ho/general-ledger
 * Mengambil buku besar per akun finansial dengan saldo awal, mutasi, dan saldo berjalan
 */
export async function getGeneralLedger(req, res) {
  try {
    const { account_id, from, to } = req.query;

    if (!account_id) {
      return res.status(400).json({ message: "Pilih akun finansial terlebih dahulu." });
    }

    // 1. Ambil info akun
    const [accRows] = await pool.query(
      `SELECT id, code, name, type, normal_balance, is_header, is_active, memo
       FROM tr_accounts WHERE id = ?`,
      [account_id]
    );

    if (accRows.length === 0) {
      return res.status(404).json({ message: "Akun finansial tidak ditemukan." });
    }

    const account = accRows[0];
    const normal = account.normal_balance; // 'DEBIT' atau 'KREDIT'

    // Range tanggal
    const fromDate = from || "1970-01-01";
    const toDate = to || new Date().toISOString().split("T")[0];

    // 2. Hitung Saldo Awal (Mutasi sebelum tanggal 'from' yang POSTED)
    const [priorRows] = await pool.query(
      `SELECT 
         COALESCE(SUM(jl.debit), 0) AS total_debit_prior,
         COALESCE(SUM(jl.credit), 0) AS total_credit_prior
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       WHERE jl.account_id = ?
         AND je.status = 'POSTED'
         AND je.entry_date < ?`,
      [account_id, fromDate]
    );

    const debitPrior = Number(priorRows[0].total_debit_prior) || 0;
    const creditPrior = Number(priorRows[0].total_credit_prior) || 0;

    let beginningBalance = 0;
    if (normal === "DEBIT") {
      beginningBalance = toFixed2(debitPrior - creditPrior);
    } else {
      beginningBalance = toFixed2(creditPrior - debitPrior);
    }

    // 3. Ambil Mutasi pada Rentang Periode 'from' sampai 'to'
    const [mutationRows] = await pool.query(
      `SELECT 
         je.id AS entry_id,
         je.entry_no,
         DATE_FORMAT(je.entry_date, '%Y-%m-%d') AS entry_date,
         je.description AS journal_description,
         jl.id AS line_id,
         jl.line_no,
         jl.debit,
         jl.credit,
         jl.memo
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       WHERE jl.account_id = ?
         AND je.status = 'POSTED'
         AND je.entry_date >= ?
         AND je.entry_date <= ?
       ORDER BY je.entry_date ASC, je.id ASC, jl.line_no ASC`,
      [account_id, fromDate, toDate]
    );

    // 4. Hitung Saldo Berjalan (Running Balance)
    let runningBalance = beginningBalance;
    let periodDebit = 0;
    let periodCredit = 0;

    const mutations = mutationRows.map((m) => {
      const d = Number(m.debit) || 0;
      const c = Number(m.credit) || 0;
      periodDebit += d;
      periodCredit += c;

      if (normal === "DEBIT") {
        runningBalance = toFixed2(runningBalance + d - c);
      } else {
        runningBalance = toFixed2(runningBalance + c - d);
      }

      return {
        ...m,
        debit: d,
        credit: c,
        running_balance: runningBalance,
      };
    });

    periodDebit = toFixed2(periodDebit);
    periodCredit = toFixed2(periodCredit);
    const endingBalance = runningBalance;
    const netChange = normal === "DEBIT" ? toFixed2(periodDebit - periodCredit) : toFixed2(periodCredit - periodDebit);

    return res.json({
      data: {
        account,
        period: {
          from: fromDate,
          to: toDate,
        },
        summary: {
          beginning_balance: beginningBalance,
          period_debit: periodDebit,
          period_credit: periodCredit,
          net_change: netChange,
          ending_balance: endingBalance,
        },
        mutations,
      },
    });
  } catch (err) {
    console.error("[getGeneralLedger] Error:", err);
    return res.status(500).json({ message: "Gagal mengambil data buku besar", error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD HO FINANCE
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /finance-ho/dashboard
 * Ringkasan Eksekutif Keuangan:
 * 1. KPI Cards: Total Pendapatan, Total Beban, Laba Bersih, Net Margin %, Realisasi Budget Beban, Kas & Bank
 * 2. Tren Bulanan 6 Bulan Terakhir (Revenue, Beban, Laba Bersih)
 * 3. Komposisi Beban Terbesar (Top 6 akun beban + budget comparison)
 * 4. Transaksi Jurnal Terkini (5 transaksi terakhir)
 */
export async function getFinanceDashboard(req, res) {
  try {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    const pad = (n) => String(n).padStart(2, "0");
    const periodStart = `${year}-${pad(month)}-01`;
    const nextMonthDate = new Date(Date.UTC(year, month, 1));
    const lastDayDate = new Date(nextMonthDate.getTime() - 1);
    const periodEnd = `${year}-${pad(month)}-${pad(lastDayDate.getUTCDate())}`;

    // 1. Total Pendapatan (Bulan Ini)
    const [revRows] = await pool.query(
      `SELECT 
         COALESCE(SUM(jl.credit - jl.debit), 0) AS total_revenue
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       JOIN tr_accounts a ON jl.account_id = a.id
       WHERE je.status = 'POSTED'
         AND a.type = 'PENDAPATAN'
         AND je.entry_date >= ? AND je.entry_date <= ?`,
      [periodStart, periodEnd]
    );
    const totalRevenue = toFixed2(revRows[0]?.total_revenue || 0);

    // 2. Total Beban (Bulan Ini)
    const [expRows] = await pool.query(
      `SELECT 
         COALESCE(SUM(jl.debit - jl.credit), 0) AS total_expense
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       JOIN tr_accounts a ON jl.account_id = a.id
       WHERE je.status = 'POSTED'
         AND a.type = 'BEBAN'
         AND je.entry_date >= ? AND je.entry_date <= ?`,
      [periodStart, periodEnd]
    );
    const totalExpense = toFixed2(expRows[0]?.total_expense || 0);

    // 3. Laba Bersih & Margin
    const netProfit = toFixed2(totalRevenue - totalExpense);
    const netMargin = totalRevenue > 0 ? toFixed2((netProfit / totalRevenue) * 100) : 0;

    // 4. Realisasi Anggaran Beban (Budget vs Actual)
    const [budgetRows] = await pool.query(
      `SELECT 
         COALESCE(SUM(b.amount), 0) AS total_budget
       FROM tr_budgets b
       JOIN tr_accounts a ON b.account_id = a.id
       WHERE a.type = 'BEBAN'
         AND b.period = ?`,
      [periodStart]
    );
    const totalBudget = toFixed2(budgetRows[0]?.total_budget || 0);
    const budgetUsedPercent = totalBudget > 0 ? toFixed2((totalExpense / totalBudget) * 100) : 0;
    const budgetRemaining = toFixed2(totalBudget - totalExpense);

    // 5. Total Saldo Kas & Bank (Per tanggal akhir periode)
    const [cashRows] = await pool.query(
      `SELECT 
         COALESCE(SUM(
           CASE 
             WHEN a.normal_balance = 'DEBIT' THEN jl.debit - jl.credit
             ELSE jl.credit - jl.debit
           END
         ), 0) AS total_cash
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       JOIN tr_accounts a ON jl.account_id = a.id
       WHERE je.status = 'POSTED'
         AND a.type = 'ASET'
         AND (LOWER(a.name) LIKE '%kas%' OR LOWER(a.name) LIKE '%bank%' OR a.code LIKE '11%')
         AND je.entry_date <= ?`,
      [periodEnd]
    );
    const totalCash = toFixed2(cashRows[0]?.total_cash || 0);

    // 6. Tren 6 Bulan Terakhir
    const trendStart = new Date(Date.UTC(year, month - 6, 1)).toISOString().split("T")[0];
    const [trendRows] = await pool.query(
      `SELECT 
         DATE_FORMAT(je.entry_date, '%Y-%m') AS ym,
         COALESCE(SUM(CASE WHEN a.type = 'PENDAPATAN' THEN jl.credit - jl.debit ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN a.type = 'BEBAN' THEN jl.debit - jl.credit ELSE 0 END), 0) AS expense
       FROM tr_journal_lines jl
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       JOIN tr_accounts a ON jl.account_id = a.id
       WHERE je.status = 'POSTED'
         AND a.type IN ('PENDAPATAN', 'BEBAN')
         AND je.entry_date >= ? AND je.entry_date <= ?
       GROUP BY ym
       ORDER BY ym ASC`,
      [trendStart, periodEnd]
    );

    const trendMap = new Map();
    trendRows.forEach((r) => {
      const rev = toFixed2(r.revenue);
      const exp = toFixed2(r.expense);
      trendMap.set(r.ym, {
        revenue: rev,
        expense: exp,
        net_profit: toFixed2(rev - exp),
      });
    });

    const monthNamesID = [
      "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
      "Jul", "Agu", "Sep", "Okt", "Nov", "Des"
    ];

    const monthlyTrends = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(year, month - 1 - i, 1));
      const ym = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
      const label = `${monthNamesID[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      const entry = trendMap.get(ym) || { revenue: 0, expense: 0, net_profit: 0 };
      monthlyTrends.push({
        ym,
        label,
        ...entry,
      });
    }

    // 7. Komposisi Beban Terbesar (Top 6 Akun Beban)
    const [topExpRows] = await pool.query(
      `SELECT 
         a.id AS account_id,
         a.code AS account_code,
         a.name AS account_name,
         COALESCE(SUM(jl.debit - jl.credit), 0) AS actual_amount,
         COALESCE(b.amount, 0) AS budget_amount
       FROM tr_accounts a
       JOIN tr_journal_lines jl ON jl.account_id = a.id
       JOIN tr_journal_entries je ON jl.entry_id = je.id
       LEFT JOIN tr_budgets b ON b.account_id = a.id AND b.period = ?
       WHERE je.status = 'POSTED'
         AND a.type = 'BEBAN'
         AND je.entry_date >= ? AND je.entry_date <= ?
       GROUP BY a.id, a.code, a.name, b.amount
       HAVING actual_amount > 0
       ORDER BY actual_amount DESC
       LIMIT 6`,
      [periodStart, periodStart, periodEnd]
    );

    const topExpenses = topExpRows.map((item) => {
      const act = toFixed2(item.actual_amount);
      const bud = toFixed2(item.budget_amount);
      const pctOfTotal = totalExpense > 0 ? toFixed2((act / totalExpense) * 100) : 0;
      const pctOfBudget = bud > 0 ? toFixed2((act / bud) * 100) : null;
      return {
        account_id: item.account_id,
        account_code: item.account_code,
        account_name: item.account_name,
        actual_amount: act,
        budget_amount: bud,
        percent_of_total: pctOfTotal,
        percent_of_budget: pctOfBudget,
      };
    });

    // 8. Transaksi Jurnal Terkini (5 Terakhir)
    const [recentJournals] = await pool.query(
      `SELECT 
         je.id,
         je.entry_no,
         DATE_FORMAT(je.entry_date, '%Y-%m-%d') AS entry_date,
         je.description,
         je.total_amount,
         je.status,
         je.created_at,
         COUNT(jl.id) AS total_lines
       FROM tr_journal_entries je
       LEFT JOIN tr_journal_lines jl ON je.id = jl.entry_id
       WHERE je.status = 'POSTED'
       GROUP BY je.id
       ORDER BY je.entry_date DESC, je.id DESC
       LIMIT 5`
    );

    return res.json({
      data: {
        period: {
          year,
          month,
          start_date: periodStart,
          end_date: periodEnd,
        },
        kpis: {
          revenue: totalRevenue,
          expense: totalExpense,
          net_profit: netProfit,
          net_margin: netMargin,
          total_budget: totalBudget,
          budget_used_percent: budgetUsedPercent,
          budget_remaining: budgetRemaining,
          cash_and_bank: totalCash,
        },
        monthly_trends: monthlyTrends,
        top_expenses: topExpenses,
        recent_journals: recentJournals.map((j) => ({
          ...j,
          total_amount: toFixed2(j.total_amount),
        })),
      },
    });
  } catch (err) {
    console.error("[getFinanceDashboard] Error:", err);
    return res.status(500).json({ message: "Gagal mengambil data dashboard keuangan", error: err.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ANGGARAN BEBAN / BUDGETS
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /finance-ho/budgets
 * Mengambil daftar anggaran akun beban beserta realisasi dan variansinya
 */
export async function getBudgets(req, res) {
  try {
    const now = new Date();
    const year = parseInt(req.query.year, 10) || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

    const pad = (n) => String(n).padStart(2, "0");
    const period = `${year}-${pad(month)}-01`;
    const periodStart = `${year}-${pad(month)}-01`;
    const nextMonthDate = new Date(Date.UTC(year, month, 1));
    const lastDayDate = new Date(nextMonthDate.getTime() - 1);
    const periodEnd = `${year}-${pad(month)}-${pad(lastDayDate.getUTCDate())}`;

    const [rows] = await pool.query(
      `SELECT 
         a.id AS account_id,
         a.code AS account_code,
         a.name AS account_name,
         a.is_active,
         b.id AS budget_id,
         COALESCE(b.amount, 0) AS budget_amount,
         COALESCE(r.realization_amount, 0) AS actual_amount
       FROM tr_accounts a
       LEFT JOIN tr_budgets b ON a.id = b.account_id AND b.period = ?
       LEFT JOIN (
         SELECT 
           jl.account_id,
           SUM(jl.debit - jl.credit) AS realization_amount
         FROM tr_journal_lines jl
         JOIN tr_journal_entries je ON jl.entry_id = je.id
         WHERE je.status = 'POSTED'
           AND je.entry_date >= ? AND je.entry_date <= ?
         GROUP BY jl.account_id
       ) r ON a.id = r.account_id
       WHERE a.type = 'BEBAN'
       ORDER BY a.code ASC`,
      [period, periodStart, periodEnd]
    );

    let totalBudget = 0;
    let totalActual = 0;
    let overbudgetCount = 0;

    const items = rows.map((row) => {
      const budget = toFixed2(row.budget_amount);
      const actual = toFixed2(row.actual_amount);
      const variance = toFixed2(budget - actual);
      const usagePercent = budget > 0 ? toFixed2((actual / budget) * 100) : (actual > 0 ? 100 : 0);
      const isOverbudget = budget > 0 && actual > budget;

      if (isOverbudget) overbudgetCount++;
      totalBudget += budget;
      totalActual += actual;

      let status = "AMAN";
      let statusLabel = "Aman";
      if (budget === 0 && actual === 0) {
        status = "BELUM_DIATUR";
        statusLabel = "Belum Diatur";
      } else if (budget === 0 && actual > 0) {
        status = "TANPA_ANGGARAN";
        statusLabel = "Tanpa Anggaran";
      } else if (isOverbudget) {
        status = "OVERBUDGET";
        statusLabel = "Melebihi budget";
      } else if (usagePercent >= 80) {
        status = "WARNING";
        statusLabel = "Mendekati Limit";
      }

      return {
        account_id: row.account_id,
        account_code: row.account_code,
        account_name: row.account_name,
        is_active: Boolean(row.is_active),
        budget_id: row.budget_id || null,
        budget_amount: budget,
        actual_amount: actual,
        variance,
        usage_percent: usagePercent,
        is_overbudget: isOverbudget,
        status,
        status_label: statusLabel,
      };
    });

    totalBudget = toFixed2(totalBudget);
    totalActual = toFixed2(totalActual);
    const totalVariance = toFixed2(totalBudget - totalActual);
    const totalUsagePercent = totalBudget > 0 ? toFixed2((totalActual / totalBudget) * 100) : 0;

    return res.json({
      data: {
        period: {
          year,
          month,
          period_date: period,
          start_date: periodStart,
          end_date: periodEnd,
        },
        summary: {
          total_budget: totalBudget,
          total_actual: totalActual,
          total_variance: totalVariance,
          total_usage_percent: totalUsagePercent,
          overbudget_count: overbudgetCount,
          total_accounts: items.length,
        },
        items,
      },
    });
  } catch (err) {
    console.error("[getBudgets] Error:", err);
    return res.status(500).json({ message: "Gagal mengambil data anggaran", error: err.message });
  }
}

/**
 * POST /finance-ho/budgets
 * Simpan atau perbarui anggaran beban per akun per bulan
 */
export async function saveBudget(req, res) {
  try {
    const { account_id, year, month, amount } = req.body;
    const actorId = req.session?.userId || req.session?.employeeId || null;

    if (!account_id) {
      return res.status(422).json({ message: "Pilih akun beban terlebih dahulu." });
    }

    if (!year || !month) {
      return res.status(422).json({ message: "Tahun dan bulan anggaran wajib diisi." });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount < 0) {
      return res.status(422).json({ message: "Nominal anggaran harus berupa angka positif." });
    }

    // Validasi akun beban
    const [acc] = await pool.query(`SELECT id, code, name, type FROM tr_accounts WHERE id = ?`, [account_id]);
    if (acc.length === 0) {
      return res.status(404).json({ message: "Akun finansial tidak ditemukan." });
    }
    if (acc[0].type !== "BEBAN") {
      return res.status(422).json({ message: "Anggaran hanya dapat ditetapkan untuk akun bertipe BEBAN." });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const period = `${year}-${pad(month)}-01`;
    const roundedAmount = toFixed2(numericAmount);

    // Ambil nilai lama sebelum update untuk audit log
    const [oldRows] = await pool.query(
      `SELECT id, amount FROM tr_budgets WHERE account_id = ? AND period = ?`,
      [account_id, period]
    );

    let budgetId = null;
    let action = "CREATE";
    const beforeValue = oldRows.length > 0 ? { amount: Number(oldRows[0].amount) } : null;

    if (oldRows.length > 0) {
      budgetId = oldRows[0].id;
      action = "UPDATE";
      await pool.query(
        `UPDATE tr_budgets SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [roundedAmount, budgetId]
      );
    } else {
      const [insertRes] = await pool.query(
        `INSERT INTO tr_budgets (account_id, period, amount) VALUES (?, ?, ?)`,
        [account_id, period, roundedAmount]
      );
      budgetId = insertRes.insertId;
    }

    // Catat ke audit log
    await pool.query(
      `INSERT INTO tr_audit_logs (entity, entity_id, action, actor_id, before_value, after_value)
       VALUES ('BUDGET', ?, ?, ?, ?, ?)`,
      [
        budgetId,
        action,
        actorId,
        beforeValue ? JSON.stringify(beforeValue) : null,
        JSON.stringify({ account_id, period, amount: roundedAmount }),
      ]
    );

    return res.json({
      message: "Anggaran berhasil disimpan.",
      data: {
        id: budgetId,
        account_id,
        period,
        amount: roundedAmount,
      },
    });
  } catch (err) {
    console.error("[saveBudget] Error:", err);
    return res.status(500).json({ message: "Gagal menyimpan anggaran", error: err.message });
  }
}

/**
 * POST /finance-ho/budgets/batch
 * Simpan / perbarui anggaran beberapa akun beban sekaligus
 */
export async function saveBatchBudgets(req, res) {
  const conn = await pool.getConnection();
  try {
    const { year, month, items } = req.body;
    const actorId = req.session?.userId || req.session?.employeeId || null;

    if (!year || !month || !Array.isArray(items)) {
      return res.status(422).json({ message: "Format payload batch anggaran tidak valid." });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const period = `${year}-${pad(month)}-01`;

    await conn.beginTransaction();

    for (const item of items) {
      const accId = Number(item.account_id);
      const amt = toFixed2(item.amount);
      if (!accId || isNaN(amt) || amt < 0) continue;

      const [existing] = await conn.query(
        `SELECT id, amount FROM tr_budgets WHERE account_id = ? AND period = ?`,
        [accId, period]
      );

      if (existing.length > 0) {
        await conn.query(
          `UPDATE tr_budgets SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [amt, existing[0].id]
        );
        await conn.query(
          `INSERT INTO tr_audit_logs (entity, entity_id, action, actor_id, before_value, after_value)
           VALUES ('BUDGET', ?, 'UPDATE', ?, ?, ?)`,
          [
            existing[0].id,
            actorId,
            JSON.stringify({ amount: Number(existing[0].amount) }),
            JSON.stringify({ account_id: accId, period, amount: amt }),
          ]
        );
      } else {
        const [ins] = await conn.query(
          `INSERT INTO tr_budgets (account_id, period, amount) VALUES (?, ?, ?)`,
          [accId, period, amt]
        );
        await conn.query(
          `INSERT INTO tr_audit_logs (entity, entity_id, action, actor_id, after_value)
           VALUES ('BUDGET', ?, 'CREATE', ?, ?)`,
          [ins.insertId, actorId, JSON.stringify({ account_id: accId, period, amount: amt })]
        );
      }
    }

    await conn.commit();
    return res.json({ message: "Batch anggaran berhasil diperbarui." });
  } catch (err) {
    await conn.rollback();
    console.error("[saveBatchBudgets] Error:", err);
    return res.status(500).json({ message: "Gagal menyimpan batch anggaran", error: err.message });
  } finally {
    conn.release();
  }
}

/**
 * POST /finance-ho/budgets/copy-previous
 * Menyalin data anggaran dari bulan sebelumnya ke bulan target
 */
export async function copyPreviousMonthBudget(req, res) {
  const conn = await pool.getConnection();
  try {
    const { year, month } = req.body;

    if (!year || !month) {
      return res.status(422).json({ message: "Bulan dan tahun target wajib dipilih." });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const targetPeriod = `${year}-${pad(month)}-01`;

    // Hitung 1 bulan sebelumnya
    const prevDate = new Date(Date.UTC(year, month - 2, 1));
    const prevPeriod = `${prevDate.getUTCFullYear()}-${pad(prevDate.getUTCMonth() + 1)}-01`;

    // Ambil data budget bulan sebelumnya
    const [prevBudgets] = await conn.query(
      `SELECT b.account_id, b.amount 
       FROM tr_budgets b
       JOIN tr_accounts a ON b.account_id = a.id
       WHERE b.period = ? AND a.type = 'BEBAN' AND b.amount > 0`,
      [prevPeriod]
    );

    if (prevBudgets.length === 0) {
      return res.status(404).json({
        message: "Tidak ditemukan data anggaran pada bulan sebelumnya untuk disalin.",
      });
    }

    await conn.beginTransaction();

    let copiedCount = 0;
    for (const b of prevBudgets) {
      const amt = toFixed2(b.amount);
      await conn.query(
        `INSERT INTO tr_budgets (account_id, period, amount)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE amount = VALUES(amount), updated_at = CURRENT_TIMESTAMP`,
        [b.account_id, targetPeriod, amt]
      );
      copiedCount++;
    }

    await conn.commit();

    return res.json({
      message: `Berhasil menyalin ${copiedCount} pos anggaran dari bulan sebelumnya.`,
      copied_count: copiedCount,
    });
  } catch (err) {
    await conn.rollback();
    console.error("[copyPreviousMonthBudget] Error:", err);
    return res.status(500).json({ message: "Gagal menyalin anggaran bulan sebelumnya", error: err.message });
  } finally {
    conn.release();
  }
}


