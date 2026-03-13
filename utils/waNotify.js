import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import db from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatIds = JSON.parse(
    readFileSync(path.join(__dirname, "../data/waChatIds.json"), "utf-8")
);

function formatDate(val) {
    if (!val) return "-";
    const d = new Date(val);
    if (isNaN(d)) return String(val);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

export async function sendWaTaskNotif({
    assigneeIds, taskTitle,
    monthlyTitle, creatorName,
    startdate, enddate, monthlyId,
}) {
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION;

    if (!url || !apiKey || !session) return;

    const appUrl = "https://central.waschenalora.com";
    const taskBoardUrl = monthlyId ? `${appUrl}/projectmanagement/month/${monthlyId}` : appUrl;

    for (const empId of assigneeIds) {
        const chatId = chatIds[String(empId)];
        if (!chatId) continue;

        let recipientName = "Karyawan";
        try {
            const [rows] = await db.query(
                "SELECT full_name FROM mst_employee WHERE employee_id = ?",
                [empId]
            );
            if (rows[0]?.full_name) recipientName = rows[0].full_name;
        } catch { /* tetap lanjut */ }

        const message = [
            `📋 *TASK BARU DITUGASKAN*`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `Halo *${recipientName}* 👋`,
            `Kamu mendapatkan penugasan task baru!`,
            ``,
            `📌 *Judul Task*`,
            `${taskTitle}`,
            ``,
            `📁 *Monthly Board*`,
            `${monthlyTitle || "-"}`,
            ``,
            `📅 *Tanggal Mulai* : ${formatDate(startdate)}`,
            `⏰ *Due Date*       : ${formatDate(enddate)}`,
            ``,
            `👤 *Ditugaskan oleh* : ${creatorName || "Supervisor"}`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `🔗 *Lihat Task Board:*`,
            `${taskBoardUrl}`,
            ``,
            `Segera cek dan konfirmasi penugasanmu ya! 💪`,
            ``,
            `_Pesan otomatis dari *Alora SuperApp*_`,
            `_${appUrl}_`,
        ].join("\n");

        try {
            await fetch(`${url}/api/sendText`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                },
                body: JSON.stringify({ session, chatId, text: message }),
            });
        } catch (err) {
            console.error(`[WA Notif] Gagal kirim ke empId ${empId}:`, err.message);
        }
    }
}

/**
 * Blast harian 15:30 — rekap progress task bulan ini per karyawan
 */
export async function sendWaDailyProgressBlast({ testEmpId = null } = {}) {
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION;

    if (!url || !apiKey || !session) {
        console.log("[WA Blast] WAHA env tidak dikonfigurasi, dilewati.");
        return;
    }

    const appUrl = "https://central.waschenalora.com";

    let rows;
    try {
        [rows] = await db.query(
            `SELECT
                a.employee_id,
                e.full_name,
                COUNT(DISTINCT t.id) AS total_assigned,
                SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS total_completed,
                SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS total_in_progress,
                SUM(
                    CASE 
                        WHEN t.status NOT IN ('completed', 'approved')
                        AND t.enddate IS NOT NULL
                        AND t.enddate < CURDATE() 
                        THEN 1 ELSE 0 
                    END
                ) AS total_overdue
            FROM tr_pm_task_assignee a
            JOIN tr_pm_task t 
                ON t.id = a.task_id
                AND t.is_deleted = 0
            JOIN tr_pm_monthly m 
                ON m.id = t.id_monthly
                AND m.is_deleted = 0
            JOIN tr_pm_project p
                ON p.id = m.id_project
                AND p.is_deleted = 0
            JOIN mst_employee e 
                ON e.employee_id = a.employee_id
                AND e.is_deleted = 0
                AND e.exit_date IS NULL
            WHERE
                m.month = MONTH(NOW())
                AND YEAR(m.created_at) = YEAR(NOW())
            GROUP BY
                a.employee_id,
                e.full_name
            HAVING
                total_assigned > 0`
        );
    } catch (err) {
        console.error("[WA Blast] Gagal query DB:", err.message);
        return;
    }

    if (!rows) rows = [];
    if (rows.length === 0) {
        console.log("[WA Blast] Tidak ada data task bulan ini, lanjut cek no-task.");
    }

    const now = new Date();
    const tanggal = now.toLocaleDateString("id-ID", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    const bulan = now.toLocaleDateString("id-ID", { month: "long", year: "numeric" });

    let sent = 0;
    for (const row of rows) {
        if (testEmpId && Number(row.employee_id) !== testEmpId) continue;

        const chatId = chatIds[String(row.employee_id)];
        if (!chatId) continue;

        const name = row.full_name || "Karyawan";
        const total = Number(row.total_assigned);
        const done = Number(row.total_completed);
        const inProgress = Number(row.total_in_progress);
        const overdue = Number(row.total_overdue);
        const remaining = total - done;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;

        const filledBlocks = Math.round(pct / 10);
        const progressBar = "█".repeat(filledBlocks) + "░".repeat(10 - filledBlocks);

        let motivasi;
        if (pct === 100) motivasi = `🎉 Luar biasa! Semua task *${bulan}* sudah selesai!`;
        else if (overdue > 0) motivasi = `⚠️ Ada *${overdue} task* melewati deadline. Yuk segera diselesaikan!`;
        else if (pct >= 70) motivasi = `💪 Hampir selesai! Tetap semangat ya!`;
        else if (pct >= 40) motivasi = `🚀 Sudah setengah jalan, terusin ya!`;
        else motivasi = `💡 Semangat menyelesaikan task hari ini!`;

        const lines = [
            `📊 *REKAP PROGRESS TASK*`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            ``,
            `Halo *${name}* 👋`,
            ``,
            `📅 *${tanggal}*`,
            `📁 Periode: *${bulan}*`,
            ``,
            `📋 *Total Task*   : ${total}`,
            `✅ *Selesai*       : ${done}`,
            `🔄 *In Progress*  : ${inProgress}`,
            `🔵 *Sisa*          : ${remaining}`,
            ...(overdue > 0 ? [`⚠️ *Overdue*       : ${overdue}`] : []),
            ``,
            `📈 *Progress ${bulan}*`,
            `[${progressBar}] ${pct}%`,
            ``,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            motivasi,
            ``,
            `🔗 *Lihat Task Board:*`,
            `${appUrl}/projectmanagement`,
            ``,
            `_Pesan otomatis dari *Alora SuperApp*_`,
        ];

        try {
            const resp = await fetch(`${url}/api/sendText`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
                body: JSON.stringify({ session, chatId, text: lines.join("\n") }),
            });
            if (resp.ok) {
                console.log(`[WA Blast] ✅ Terkirim ke ${name} (${row.employee_id})`);
                sent++;
            } else {
                const body = await resp.text();
                console.error(`[WA Blast] ❌ Gagal ke ${name}: HTTP ${resp.status} — ${body}`);
            }
        } catch (err) {
            console.error(`[WA Blast] ❌ Error kirim ke empId ${row.employee_id}:`, err.message);
        }
    }

    // --- Blast untuk karyawan TANPA task bulan ini ---
    const empIdsWithTasks = new Set(rows.map(r => String(r.employee_id)));
    const noTaskEmpIds = Object.entries(chatIds)
        .filter(([id, cid]) => cid && !empIdsWithTasks.has(id))
        .map(([id]) => Number(id));

    if (noTaskEmpIds.length > 0) {
        let noTaskEmployees = [];
        try {
            [noTaskEmployees] = await db.query(
                `SELECT employee_id, full_name FROM mst_employee
             WHERE employee_id IN (?) AND is_deleted = 0 AND exit_date IS NULL`,
                [noTaskEmpIds]
            );
        } catch (err) {
            console.error("[WA Blast] Gagal query no-task employees:", err.message);
        }

        for (const emp of noTaskEmployees) {
            if (testEmpId && Number(emp.employee_id) !== testEmpId) continue;

            const chatId = chatIds[String(emp.employee_id)];
            if (!chatId) continue;

            const name = emp.full_name || "Karyawan";
            const noTaskLines = [
                `📊 *REKAP PROGRESS TASK*`,
                `━━━━━━━━━━━━━━━━━━━━━━`,
                ``,
                `Halo *${name}* 👋`,
                ``,
                `📅 *${tanggal}*`,
                `📁 Periode: *${bulan}*`,
                ``,
                `📭 Kamu belum memiliki task yang ditugaskan bulan ini.`,
                ``,
                `━━━━━━━━━━━━━━━━━━━━━━`,
                `💡 Hubungi supervisormu jika ada penugasan baru!`,
                ``,
                `🔗 *Lihat Task Board:*`,
                `${appUrl}/projectmanagement`,
                ``,
                `_Pesan otomatis dari *Alora SuperApp*_`,
            ];

            try {
                const resp = await fetch(`${url}/api/sendText`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
                    body: JSON.stringify({ session, chatId, text: noTaskLines.join("\n") }),
                });
                if (resp.ok) {
                    console.log(`[WA Blast] ✅ (no-task) Terkirim ke ${name} (${emp.employee_id})`);
                    sent++;
                } else {
                    const body = await resp.text();
                    console.error(`[WA Blast] ❌ (no-task) Gagal ke ${name}: HTTP ${resp.status} — ${body}`);
                }
            } catch (err) {
                console.error(`[WA Blast] ❌ Error kirim no-task ke empId ${emp.employee_id}:`, err.message);
            }
        }
    }

    const totalTarget = rows.length + (noTaskEmpIds?.length ?? 0);
    console.log(`[WA Blast] Selesai. Terkirim ${sent}/${totalTarget} karyawan.`);
}