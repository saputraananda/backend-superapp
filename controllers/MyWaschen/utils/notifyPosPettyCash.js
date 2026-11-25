/**
 * Kabari POS My Waschen bahwa pengajuan petty cash berubah (disetujui / ditolak / diedit / dihapus),
 * supaya kartu "Uang Tunai di Laci" & daftar kas di POS langsung menghitung ulang tanpa refresh.
 * Gagal kirim tidak membatalkan aksi admin.
 * Env: WASCHEN_POS_PUBLIC_BASE_URL (alamat API POS) + WASCHEN_POS_TOKEN (sama dengan di POS).
 */
export async function notifyPosPettyCashUpdated({ id, outletId } = {}) {
  const token = process.env.WASCHEN_POS_TOKEN || "";
  if (!token || (!id && !outletId)) return;
  const base = (process.env.WASCHEN_POS_PUBLIC_BASE_URL || "https://pos.mywaschen.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/api/internal/petty-cash-updated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Complaint-Sync-Token": token },
      body: JSON.stringify({ id: Number(id) || null, outletId: Number(outletId) || null }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn("[notifyPosPettyCashUpdated]", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.warn("[notifyPosPettyCashUpdated] skipped:", err.cause?.code || err.message);
  }
}
