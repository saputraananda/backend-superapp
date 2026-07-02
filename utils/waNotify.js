import db from "../db/pool.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(val) {
    if (!val) return "-";
    const d = new Date(val);
    if (isNaN(d)) return String(val);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

/**
 * Normalisasi nomor HP ke format KirimDev (+628xx).
 * Menangani format: 08xxx, +628xxx, 628xxx, spasi, tanda baca, dsb.
 * Return null jika nomor tidak valid / kosong.
 */
function phoneToKirimdev(phone) {
    if (!phone) return null;
    // Hapus semua karakter selain angka
    let n = String(phone).replace(/[^\d]/g, "");
    if (!n) return null;

    // Konversi awalan 0 → 62
    if (n.startsWith("0")) n = "62" + n.slice(1);

    // Harus diawali 62 dan punya panjang wajar (10–15 digit)
    if (!n.startsWith("62") || n.length < 10 || n.length > 16) return null;

    return `+${n}`;
}

/**
 * Ambil nomor HP KirimDev dari DB untuk satu atau banyak employee_id.
 * Return Map<employee_id (number), phone (string)>
 */
async function getPhoneMap(empIds) {
    const map = new Map();
    if (!empIds || empIds.length === 0) return map;

    const uniqueIds = [...new Set(empIds.map(Number).filter((id) => !isNaN(id)))];
    if (uniqueIds.length === 0) return map;

    try {
        const [rows] = await db.query(
            `SELECT employee_id, phone_number
             FROM mst_employee
             WHERE employee_id IN (?)
               AND is_deleted = 0
               AND exit_date IS NULL`,
            [uniqueIds]
        );
        for (const row of rows) {
            const phoneStr = phoneToKirimdev(row.phone_number);
            if (phoneStr) map.set(Number(row.employee_id), phoneStr);
        }
    } catch (err) {
        console.error("[WA] Gagal query phone_number:", err.message);
    }
    return map;
}

// ── Public functions ─────────────────────────────────────────────────────────

export async function sendWaTaskNotif({
    assigneeIds, taskTitle,
    monthlyTitle, creatorName,
    startdate, enddate, monthlyId,
}) {
    const apiKey = process.env.KIRIMDEV_API;
    const numberId = process.env.KIRIMDEV_NUMBER_ID_ALSA;
    const baseUrl = (process.env.KIRIMDEV_URL || "https://api.kirimdev.com/v1").replace(/\/$/, "");

    if (!apiKey || !numberId) return;

    const url = `${baseUrl}/${numberId}/messages`;
    const appUrl = "https://central.waschenalora.com";
    const taskBoardUrl = monthlyId ? `${appUrl}/projectmanagement/month/${monthlyId}` : appUrl;

    const phoneMap = await getPhoneMap(assigneeIds);

    for (const empId of assigneeIds) {
        const recipientPhone = phoneMap.get(Number(empId));
        if (!recipientPhone) continue;

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
            await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: recipientPhone,
                    type: "text",
                    text: { body: message },
                }),
            });
        } catch (err) {
            console.error(`[WA Notif] Gagal kirim ke empId ${empId}:`, err.message);
        }
    }
}

export async function sendWaSimpleNotif({ recipientIds, message }) {
    const apiKey = process.env.KIRIMDEV_API;
    const numberId = process.env.KIRIMDEV_NUMBER_ID_ALSA;
    const baseUrl = (process.env.KIRIMDEV_URL || "https://api.kirimdev.com/v1").replace(/\/$/, "");

    if (!apiKey || !numberId) return;

    const url = `${baseUrl}/${numberId}/messages`;
    const phoneMap = await getPhoneMap(recipientIds);

    for (const empId of recipientIds) {
        const recipientPhone = phoneMap.get(Number(empId));
        if (!recipientPhone) continue;
        try {
            await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: recipientPhone,
                    type: "text",
                    text: { body: message },
                }),
            });
        } catch (err) {
            console.error(`[WA Notif] Gagal kirim ke empId ${empId}:`, err.message);
        }
    }
}