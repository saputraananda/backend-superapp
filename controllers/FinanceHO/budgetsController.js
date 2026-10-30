import { pool, safeQuery } from "../../db/pool.js";
import { toFixed2 } from "./currencyHelpers.js";

// ════════════════════════════════════════════════════════════════════════════
// ANGGARAN BEBAN / BUDGETS
// ════════════════════════════════════════════════════════════════════════════

// ── Inisialisasi Tabel Anggaran (tr_budgets) ─────────────────────────────────
const initDb = async () => {
    try {
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
    } catch (err) {
        console.error("❌ Failed to initialize tr_budgets table:", err.message);
    }
};
initDb();



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
