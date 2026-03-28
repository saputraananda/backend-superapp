import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { safeSmartlinkQuery, safeCleanoxQuery } from "../db/pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IMAGE_PATH = path.join(__dirname, "../assets/cleanox.webp");
const IMAGE_PATH_WASCHEN = path.join(__dirname, "../assets/Foto_Broadcast_Waschen.webp");
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function toWaChatId(nomor) {
    if (!nomor) return null;
    let num = String(nomor).replace(/\D/g, "");
    if (!num) return null;
    if (num.startsWith("0")) num = "62" + num.slice(1);
    else if (!num.startsWith("62")) num = "62" + num;
    if (num.length < 10) return null;
    return `${num}@c.us`;
}

export async function sendIdulFitriBlastWaschenProd() {
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION_waschen;

    if (!url || !apiKey || !session) {
        console.log("[WA Idul Fitri Waschen Prod] WAHA env tidak dikonfigurasi, dilewati.");
        return;
    }

    let imageBase64;
    try {
        imageBase64 = readFileSync(IMAGE_PATH_WASCHEN).toString("base64");
    } catch (err) {
        console.error("[WA Idul Fitri Waschen Prod] Gagal membaca file foto:", err.message);
        return;
    }

    const BLAST_TYPE = "idul_fitri_waschen_2026";

    let rows;
    try {
        [rows] = await safeSmartlinkQuery(`
            SELECT nomor_telpon
            FROM customer
            WHERE nama NOT LIKE '%haji%'
              AND nama NOT LIKE '%tni%'
              AND nama NOT LIKE '%dumm%'
              AND nama NOT LIKE '%tes%'
              AND nomor_telpon IS NOT NULL
              AND nomor_telpon <> ''
              AND transaksi_terakhir IS NOT NULL
              AND total_jumlah_transaksi >= 50
              AND transaksi_terakhir BETWEEN '2025-06-26' AND '2026-03-19'
              AND nomor_telpon NOT IN (
                SELECT nomor_telepon FROM customer_log WHERE blast_type = ?
              )
        `, [BLAST_TYPE]);
    } catch (err) {
        console.error("[WA Idul Fitri Waschen Prod] Gagal ambil data dari DB:", err.message);
        return;
    }

    const text = [
        `🌙 Siap menyambut momen penuh berkah🌙`,
        ``,
        `Kami mengucapkan terima kasih atas kepercayaan dan loyalitas Bapak/Ibu kepada *Waschen Laundry*.`,
        ``,
        `Dalam rangka menyambut Hari Raya Idul Fitri,`,
        `Waschen Laundry tetap melayani seperti biasa selama periode Lebaran.`,
        `Kami hanya akan tutup sementara selama 3 hari pada:`,
        ``,
        `*20 – 22 Maret 2026*`,
        ``,
        `Dan akan kembali beroperasi normal mulai:`,
        ``,
        `*23 Maret 2026*`,
        ``,
        `Terima kasih atas pengertiannya.`,
        `Selamat menyambut Hari Raya Idul Fitri✨🥰`,
        ``,
        `Salam Hangat,`,
        `*Keluarga Besar Waschen Laundry*`,
    ].join("\n");

    const logCustomer = async (nomor, status) => {
        try {
            await safeSmartlinkQuery(
                "INSERT INTO customer_log (nomor_telepon, blast_type, status) VALUES (?, ?, ?)",
                [nomor, BLAST_TYPE, status]
            );
        } catch (err) {
            console.error(`[WA Idul Fitri Waschen Prod] Gagal insert log untuk ${nomor}:`, err.message);
        }
    };

    let sent = 0;
    for (const row of rows) {
        const chatId = toWaChatId(row.nomor_telpon);
        if (!chatId) {
            console.warn(`[WA Idul Fitri Waschen Prod] Nomor tidak valid, dilewati: ${row.nomor_telpon}`);
            await logCustomer(row.nomor_telpon, "no");
            continue;
        }

        let success = false;
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
                        filename: "Foto_Broadcast_Waschen.webp",
                    },
                }),
            });

            if (!imgResp.ok) {
                const body = await imgResp.text();
                console.error(`[WA Idul Fitri Waschen Prod] Gagal kirim foto ke ${chatId}: HTTP ${imgResp.status} — ${body}`);
            } else {
                const txtResp = await fetch(`${url}/api/sendText`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Api-Key": apiKey,
                    },
                    body: JSON.stringify({ session, chatId, text }),
                });

                if (txtResp.ok) {
                    console.log(`[WA Idul Fitri Waschen Prod] Terkirim ke ${chatId}`);
                    sent++;
                    success = true;
                } else {
                    const body = await txtResp.text();
                    console.error(`[WA Idul Fitri Waschen Prod] Gagal kirim teks ke ${chatId}: HTTP ${txtResp.status} — ${body}`);
                }
            }
        } catch (err) {
            console.error(`[WA Idul Fitri Waschen Prod] Error kirim ke ${chatId}:`, err.message, err.cause);
        }

        await logCustomer(row.nomor_telpon, success ? "yes" : "no");
        await delay(100000); // 1 menit
    }

    console.log(`[WA Idul Fitri Waschen Prod] Selesai. Terkirim ${sent}/${rows.length}.`);
    return { sent, total: rows.length };
}

export async function sendIdulFitriBlastCleanoxProd() {
    const url = process.env.WAHA_URL;
    const apiKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION_cleanox;

    if (!url || !apiKey || !session) {
        console.log("[WA Idul Fitri Cleanox Prod] WAHA env tidak dikonfigurasi, dilewati.");
        return;
    }

    let imageBase64;
    try {
        imageBase64 = readFileSync(IMAGE_PATH).toString("base64");
    } catch (err) {
        console.error("[WA Idul Fitri Cleanox Prod] Gagal membaca file foto:", err.message);
        return;
    }

    let rows;
    try {
        [rows] = await safeCleanoxQuery("SELECT nomor_telpon FROM customer_cleanox");
    } catch (err) {
        console.error("[WA Idul Fitri Cleanox Prod] Gagal ambil data dari DB:", err.message);
        return;
    }

    const text = [
        `Halo Kak 😊🙏🏻✨`,
        ``,
        `Setelah perjalanan mudik, biasanya rumah terasa lebih berdebu dan kurang segar ya.`,
        ``,
        `Saat ini ada Promo Spesial Setelah Lebaran:`,
        ``,
        `🎉 *Diskon Hingga 50% + Tambahan 10%*`,
        ``,
        `✅ General Cleaning & Deep Cleaning untuk Rumah Lebih Bersih Maksimal`,
        `✅ Pembersihan Furniture hingga Mobil Secara Menyeluruh`,
        `✅ Hilangkan Debu & Bau Membandel`,
        `✅ Membunuh Bakteri & Tungau`,
        `✅ Hasil Lebih Bersih & Segar`,
        ``,
        `⚠️ Slot terbatas setiap hari`,
        ``,
        `Mau Minox bantu cek jadwal terdekat, Kak?😊🙏🏻`,
    ].join("\n");

    let sent = 0;
    for (const row of rows) {
        const chatId = toWaChatId(row.nomor_telpon);
        if (!chatId) {
            console.warn(`[WA Idul Fitri Cleanox Prod] Nomor tidak valid, dilewati: ${row.nomor_telpon}`);
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
                        filename: "cleanox.webp",
                    },
                }),
            });

            if (!imgResp.ok) {
                const body = await imgResp.text();
                console.error(`[WA Idul Fitri Cleanox Prod] Gagal kirim foto ke ${chatId}: HTTP ${imgResp.status} — ${body}`);
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
                console.log(`[WA Idul Fitri Cleanox Prod] Terkirim ke ${chatId}`);
                sent++;
            } else {
                const body = await txtResp.text();
                console.error(`[WA Idul Fitri Cleanox Prod] Gagal kirim teks ke ${chatId}: HTTP ${txtResp.status} — ${body}`);
            }
        } catch (err) {
            console.error(`[WA Idul Fitri Cleanox Prod] Error kirim ke ${chatId}:`, err.message, err.cause);
        }

        await delay(10000); // ← tambahkan di sini
    }

    console.log(`[WA Idul Fitri Cleanox Prod] Selesai. Terkirim ${sent}/${rows.length}.`);
    return { sent, total: rows.length };
}

export async function getBlastWaschenPendingCount() {
    const [rows] = await safeSmartlinkQuery(
        `SELECT COUNT(*) AS total FROM customer
     WHERE nama NOT LIKE '%haji%' AND nama NOT LIKE '%tni%'
       AND nama NOT LIKE '%dumm%' AND nama NOT LIKE '%tes%'
       AND nomor_telpon IS NOT NULL AND nomor_telpon <> ''
       AND transaksi_terakhir IS NOT NULL
       AND total_jumlah_transaksi >= 50
       AND transaksi_terakhir BETWEEN '2025-06-26' AND '2026-03-19'
       AND nomor_telpon NOT IN (
         SELECT nomor_telepon FROM customer_log WHERE blast_type = 'idul_fitri_waschen_2026'
       )`,
        []
    );
    return Number(rows[0].total) || 0;
}