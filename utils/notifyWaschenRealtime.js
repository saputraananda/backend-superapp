/**
 * Push event ke Waschen Mobile Socket.IO agar halaman mobile auto-refresh.
 * Env (opsional, tidak wajib di .env kalau default localhost):
 *   WASCHEN_MOBILE_API_URL=http://localhost:9001
 *   WASCHEN_MOBILE_REALTIME_SECRET=<sama dengan REALTIME_SECRET / SESSION_SECRET mobile>
 */
export async function notifyWaschenRealtime({ domain, outletId = null, employeeId = null, action = null, meta = null }) {
  const base = (process.env.WASCHEN_MOBILE_API_URL || "http://localhost:9001").replace(/\/$/, "");
  const secret =
    process.env.WASCHEN_MOBILE_REALTIME_SECRET ||
    process.env.REALTIME_SECRET ||
    process.env.SESSION_SECRET ||
    "waschensecret";

  if (!domain) return;

  try {
    const res = await fetch(`${base}/api/realtime/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Realtime-Secret": secret,
      },
      body: JSON.stringify({ domain, outletId, employeeId, action, meta }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[notifyWaschenRealtime]", res.status, text);
    }
  } catch (err) {
    console.warn("[notifyWaschenRealtime] skipped:", err.message);
  }
}
