/**
 * Kabari POS My Waschen bahwa outlet berubah (Wajib Shift, Aktif, Drop Point), supaya semua
 * layar POS langsung menyesuaikan gerbang shift tanpa login ulang.
 * POS membaca ulang flag dari DB, jadi yang dikirim hanya id. Gagal kirim tidak membatalkan simpan.
 * Env: WASCHEN_POS_PUBLIC_BASE_URL (alamat API POS) + WASCHEN_POS_TOKEN (sama dengan di POS).
 */
export async function notifyPosOutletUpdated(outletId) {
  const token = process.env.WASCHEN_POS_TOKEN || "";
  const id = Number(outletId) || 0;
  if (!token || !id) return;
  const base = (process.env.WASCHEN_POS_PUBLIC_BASE_URL || "https://pos.mywaschen.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/internal/outlet-updated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Complaint-Sync-Token": token },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn("[notifyPosOutletUpdated]", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.warn("[notifyPosOutletUpdated] skipped:", err.cause?.code || err.message);
  }
}
