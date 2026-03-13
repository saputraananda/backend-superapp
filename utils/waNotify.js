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