import { pool, safeQuery } from "../../db/pool.js";
import { formatRupiah, toFixed2 } from "./currencyHelpers.js";

// ════════════════════════════════════════════════════════════════════════════
// TRANSAKSI JURNAL UMUM (tr_journal_entries & tr_journal_lines)
// ════════════════════════════════════════════════════════════════════════════


// ── Initialize Tables: Jurnal Umum & Audit Logs ───────────────────────
const initDb = async () => {
  try {
    // 1. Header Jurnal Umum (Journal Entries)
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

    // 2. Baris Jurnal (Journal Lines)
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

    // 3. Tabel Audit Logs
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
    console.error("❌ Failed to initialize Finance Journal tables:", err.message);
  }
};
initDb();



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





