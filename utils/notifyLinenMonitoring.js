/**
 * Notify Linen Monitoring (Socket.IO) via HTTP bridge.
 * Tidak menambah dependency socket.io di Alsa.
 *
 * Env opsional (tanpa wajib ubah .env):
 * - LINEN_MONITORING_URL  → base URL LMS (default dari IKM_SIGNATURE_BASE_URL origin / localhost:5000)
 * - LINEN_MONITORING_NOTIFY_SECRET → harus sama dengan LMS
 */
function resolveLinenMonitoringUrl() {
  if (process.env.LINEN_MONITORING_URL) {
    return process.env.LINEN_MONITORING_URL.replace(/\/$/, '');
  }
  // Local Alsa → local LMS socket bridge
  if (process.env.NODE_ENV !== 'production') {
    return 'http://localhost:5000';
  }
  const sig = process.env.IKM_SIGNATURE_BASE_URL;
  if (sig) {
    try {
      return new URL(sig).origin;
    } catch {
      /* ignore */
    }
  }
  return 'https://linen.ikmalora.com';
}

const NOTIFY_SECRET =
  process.env.LINEN_MONITORING_NOTIFY_SECRET ||
  process.env.INTERNAL_NOTIFY_SECRET ||
  'alora-linen-notify';

export async function notifyLinenMonitoring(hospitalId, type = 'HOSPITAL_LINEN_MASTER', message = 'Master linen RS diperbarui') {
  if (!hospitalId) return;

  const base = resolveLinenMonitoringUrl();
  const url = `${base}/api/internal/socket-notify`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-notify-secret': NOTIFY_SECRET,
      },
      body: JSON.stringify({
        hospitalId: Number(hospitalId),
        type,
        message,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[notifyLinenMonitoring] ${res.status} ${url}`, text);
    }
  } catch (err) {
    // Jangan gagalkan CRUD Alsa jika LMS down
    console.warn('[notifyLinenMonitoring] gagal:', err.message);
  }
}

export async function notifyLinenMonitoringMany(hospitalIds, type, message) {
  const unique = [...new Set((hospitalIds || []).map(Number).filter(Boolean))];
  await Promise.all(unique.map((id) => notifyLinenMonitoring(id, type, message)));
}
