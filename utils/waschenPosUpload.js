/**
 * Titip file ke server POS Waschen (folder uploads POS), lewat endpoint internal bertoken.
 * Env: WASCHEN_POS_PUBLIC_BASE_URL, WASCHEN_POS_TOKEN (sama dengan lampiran komplain).
 */
export function posOrigin() {
  return (process.env.WASCHEN_POS_PUBLIC_BASE_URL || "https://pos.mywaschen.com").replace(/\/$/, "");
}

/** URL relatif POS (/uploads/...) → absolut supaya bisa dibuka dari Super App. */
export function posFileUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${posOrigin()}/${String(url).replace(/^\/+/, "")}`;
}

/** @returns {Promise<string>} public path POS, contoh: /uploads/assets/delete-request/x.jpg */
export async function uploadDeleteRequestAttachment(file) {
  const token = process.env.WASCHEN_POS_TOKEN || "";
  if (!token) {
    throw new Error("Gagal menyimpan lampiran: WASCHEN_POS_TOKEN belum di-set di server API.");
  }
  const body = new FormData();
  body.append(
    "attachment",
    new Blob([file.buffer], { type: file.mimetype }),
    file.originalname || "lampiran",
  );

  const url = `${posOrigin()}/api/internal/delete-request-docs`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "X-Complaint-Sync-Token": token }, body });
  } catch (err) {
    throw new Error(`Gagal menyimpan lampiran: server POS tidak bisa dihubungi (${err.cause?.code || err.message}).`);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Gagal menyimpan lampiran: token POS ditolak.");
  if (!res.ok || !json.path) {
    throw new Error(json.message || `Gagal menyimpan lampiran (POS membalas ${res.status}).`);
  }
  return json.path;
}
