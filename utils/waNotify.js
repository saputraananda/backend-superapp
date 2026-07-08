import db from "../db/pool.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(val) {
    if (!val) return "-";
    const d = new Date(val);
    if (isNaN(d)) return String(val);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

/**
 * Normalisasi nomor HP ke format WhatsApp (628xx).
 * Menangani format: 08xxx, +628xxx, 628xxx, spasi, tanda baca, dsb.
 * Return null jika nomor tidak valid / kosong.
 */
function phoneToWhatsapp(phone) {
    if (!phone) return null;
    // Hapus semua karakter selain angka
    let n = String(phone).replace(/[^\d]/g, "");
    if (!n) return null;

    // Konversi awalan 0 → 62
    if (n.startsWith("0")) n = "62" + n.slice(1);

    // Harus diawali 62 dan punya panjang wajar (10–16 digit)
    if (!n.startsWith("62") || n.length < 10 || n.length > 16) return null;

    return n;
}

/**
 * Ambil nomor HP WhatsApp dari DB untuk satu atau banyak employee_id.
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
            const phoneStr = phoneToWhatsapp(row.phone_number);
            if (phoneStr) map.set(Number(row.employee_id), phoneStr);
        }
    } catch (err) {
        console.error("[WA] Gagal query phone_number:", err.message);
    }
    return map;
}

// ── Public functions ─────────────────────────────────────────────────────────

function getWaHeaders() {
    const headers = { "Content-Type": "application/json" };
    // Optional API key — set ALORA_WA_API_KEY jika gateway butuh auth
    if (process.env.ALORA_WA_API_KEY) {
        headers["x-api-key"] = process.env.ALORA_WA_API_KEY;
    }
    return headers;
}

export async function sendWaTaskNotif({
    assigneeIds, taskTitle,
    monthlyTitle, creatorName,
    startdate, enddate, monthlyId,
}) {
    const baseUrl = (process.env.ALORA_WA_URL || "http://43.129.37.205:3000").replace(/\/$/, "");
    const session = process.env.ALORA_WA_ALORA_SESSION || "alora";

    if (!baseUrl) return;

    const url = `${baseUrl}/api/send-message`;
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
            const response = await fetch(url, {
                method: "POST",
                headers: getWaHeaders(),
                body: JSON.stringify({
                    session: session,
                    to: recipientPhone,
                    message: message,
                }),
            });
            if (!response.ok) {
                const errText = await response.text();
                console.error(`[WA Notif] Gateway error (status ${response.status}):`, errText);
            }
        } catch (err) {
            console.error(`[WA Notif] Gagal kirim ke empId ${empId}:`, err.message);
        }
    }
}

export async function sendWaSimpleNotif({ recipientIds, message }) {
    const baseUrl = (process.env.ALORA_WA_URL || "http://43.129.37.205:3000").replace(/\/$/, "");
    const session = process.env.ALORA_WA_ALORA_SESSION || "alora";

    if (!baseUrl) return;

    const url = `${baseUrl}/api/send-message`;
    const phoneMap = await getPhoneMap(recipientIds);

    for (const empId of recipientIds) {
        const recipientPhone = phoneMap.get(Number(empId));
        if (!recipientPhone) continue;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: getWaHeaders(),
                body: JSON.stringify({
                    session: session,
                    to: recipientPhone,
                    message: message,
                }),
            });
            if (!response.ok) {
                const errText = await response.text();
                console.error(`[WA Notif] Gateway error (status ${response.status}):`, errText);
            }
        } catch (err) {
            console.error(`[WA Notif] Gagal kirim ke empId ${empId}:`, err.message);
        }
    }
}