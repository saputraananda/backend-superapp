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
