import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const chatIds = JSON.parse(
    readFileSync(path.join(__dirname, "../data/waChatIds.json"), "utf-8")
);

const TARGET_EMP_IDS = 31;
const IMAGE_PATH = path.join(__dirname, "../assets/Foto_Broadcast_Cleanox.webp");
const IMAGE_PATH_WASCHEN = path.join(__dirname, "../assets/Foto_Broadcast_Waschen.webp");

export async function sendIdulFitriBlastWaschen() {
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION;

    if (!url || !apiKey || !session) {
        console.log("[WA Idul Fitri Waschen] WAHA env tidak dikonfigurasi, dilewati.");
        return;
    }

    let imageBase64;
    try {
        imageBase64 = readFileSync(IMAGE_PATH_WASCHEN).toString("base64");
    } catch (err) {
        console.error("[WA Idul Fitri Waschen] Gagal membaca file foto:", err.message);
        return;
    }

    const text = [
        `🌙 *SELAMAT HARI RAYA IDUL FITRI 1447 H* 🌙`,
        ``,
        `Mohon Maaf Lahir dan Batin 🙏`,
        ``,
        `Di hari yang penuh kemenangan ini, kami mengucapkan terima kasih atas kepercayaan dan loyalitas Bapak/Ibu kepada *Waschen Laundry*.`,
        ``,
        `Semoga kebahagiaan, kedamaian, dan keberkahan senantiasa menyertai langkah kita semua.`,
        ``,
        `Salam hangat,`,
        `*Keluarga Besar Waschen Laundry* ✨`,
    ].join("\n");

    let sent = 0;
    for (const empId of TARGET_EMP_IDS) {
        const chatId = chatIds[String(empId)];
        if (!chatId) {
            console.warn(`[WA Idul Fitri Waschen] Tidak ada chatId untuk empId ${empId}, dilewati.`);
            continue;
        }

        try {
            // 1. Kirim foto terlebih dahulu
            const imgResp = await fetch(`${url}/api/sendImage`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                },
                body: JSON.stringify({
                    session,
                    chatId,
                    file: {
                        data: imageBase64,
                        mimetype: "image/webp",
                        filename: "Foto_Broadcast_Waschen.webp",
                    },
                }),
            });

            if (!imgResp.ok) {
                const body = await imgResp.text();
                console.error(`[WA Idul Fitri Waschen] Gagal kirim foto ke empId ${empId}: HTTP ${imgResp.status} — ${body}`);
                continue;
            }

            // 2. Kirim teks setelah foto
            const txtResp = await fetch(`${url}/api/sendText`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                },
                body: JSON.stringify({ session, chatId, text }),
            });

            if (txtResp.ok) {
                console.log(`[WA Idul Fitri Waschen] Terkirim ke empId ${empId} (${chatId})`);
                sent++;
            } else {
                const body = await txtResp.text();
                console.error(`[WA Idul Fitri Waschen] Gagal kirim teks ke empId ${empId}: HTTP ${txtResp.status} — ${body}`);
            }
        } catch (err) {
            console.error(`[WA Idul Fitri Waschen] Error kirim ke empId ${empId}:`, err.message);
        }
    }

    console.log(`[WA Idul Fitri Waschen] Selesai. Terkirim ${sent}/${TARGET_EMP_IDS.length}.`);
    return { sent, total: TARGET_EMP_IDS.length };
}

export async function sendIdulFitriBlastCleanox() { 
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION_CLEANOX;

    if (!url || !apiKey || !session) {
        console.log("[WA Idul Fitri Cleanox] WAHA env tidak dikonfigurasi, dilewati.");
        return;
    }

    let imageBase64;
    try {
        imageBase64 = readFileSync(IMAGE_PATH).toString("base64");
    } catch (err) {
        console.error("[WA Idul Fitri Cleanox] Gagal membaca file foto:", err.message);
        return;
    }

    const text = [
        `🌙 *SELAMAT HARI RAYA IDUL FITRI 1447 H* 🌙`,
        ``,
        `Mohon Maaf Lahir dan Batin 🙏`,
        ``,
        `Di hari yang penuh kemenangan ini, kami mengucapkan terima kasih atas kepercayaan dan loyalitas Bapak/Ibu kepada *Cleanox*.`,
        ``,
        `Semoga kebahagiaan, kedamaian, dan keberkahan senantiasa menyertai langkah kita semua.`,
        ``,
        `Salam hangat,`,
        `*Keluarga Besar Cleanox* ✨`,
    ].join("\n");

    let sent = 0;
    for (const empId of TARGET_EMP_IDS) {
        const chatId = chatIds[String(empId)];
        if (!chatId) {
            console.warn(`[WA Idul Fitri Cleanox] Tidak ada chatId untuk empId ${empId}, dilewati.`);
            continue;
        }

        try {
            const imgResp = await fetch(`${url}/api/sendImage`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                },
                body: JSON.stringify({
                    session,
                    chatId,
                    file: {
                        data: imageBase64,
                        mimetype: "image/webp",
                        filename: "Foto_Broadcast_Cleanox2.webp",
                    },
                }),
            });

            if (!imgResp.ok) {
                const body = await imgResp.text();
                console.error(`[WA Idul Fitri Cleanox] Gagal kirim foto ke empId ${empId}: HTTP ${imgResp.status} — ${body}`);
                continue;
            }

            const txtResp = await fetch(`${url}/api/sendText`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Api-Key": apiKey,
                },
                body: JSON.stringify({ session, chatId, text }),
            });

            if (txtResp.ok) {
                console.log(`[WA Idul Fitri Cleanox] Terkirim ke empId ${empId} (${chatId})`);
                sent++;
            } else {
                const body = await txtResp.text();
                console.error(`[WA Idul Fitri Cleanox] Gagal kirim teks ke empId ${empId}: HTTP ${txtResp.status} — ${body}`);
            }
        } catch (err) {
            console.error(`[WA Idul Fitri Cleanox] Error kirim ke empId ${empId}:`, err.message, err.cause);
        }
    }

    console.log(`[WA Idul Fitri Cleanox] Selesai. Terkirim ${sent}/${TARGET_EMP_IDS.length}.`);
    return { sent, total: TARGET_EMP_IDS.length };
}