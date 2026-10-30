
import { pool } from "../../db/pool.js";
import { toFixed2 } from "./currencyHelpers.js";

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