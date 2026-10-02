/**
 * Titip file ke server Waschen Mobile (satu folder dengan upload mobile).
 * Env sama dengan notifyWaschenRealtime:
 *   WASCHEN_MOBILE_API_URL, WASCHEN_MOBILE_REALTIME_SECRET | REALTIME_SECRET | SESSION_SECRET
 */
function realtimeBase() {
  return (process.env.WASCHEN_MOBILE_API_URL || "http://localhost:9001").replace(/\/$/, "");
}

function realtimeSecret() {
  return (
    process.env.WASCHEN_MOBILE_REALTIME_SECRET ||
    process.env.REALTIME_SECRET ||
    process.env.SESSION_SECRET ||
    "waschensecret"
  );
}

/** @returns {Promise<string>} public path, contoh: /uploads/assets/kasbon/bayar_x.jpg */
export async function uploadKasbonPaymentProof(file) {
  const body = new FormData();
  body.append(
    "proof",
    new Blob([file.buffer], { type: file.mimetype }),
    file.originalname || "bukti",
  );

  const res = await fetch(`${realtimeBase()}/api/realtime/upload-kasbon-payment`, {
    method: "POST",
    headers: { "X-Realtime-Secret": realtimeSecret() },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(
      "Server Waschen Mobile menolak koneksi (secret tidak cocok). Samakan WASCHEN_MOBILE_REALTIME_SECRET di Alsa dengan REALTIME_SECRET/SESSION_SECRET Waschen Mobile.",
    );
  }
  if (!res.ok || !json.path) {
    throw new Error(json.message || "Gagal mengunggah bukti ke server Waschen Mobile");
  }
  return json.path;
}

/** Titip file slip gaji ke disk privat Waschen Mobile. @returns {Promise<string>} nama file */
export async function uploadWaschenPayslipFile(file) {
  const body = new FormData();
  body.append(
    "file",
    new Blob([file.buffer], { type: file.mimetype }),
    file.originalname || "slip-gaji",
  );
  const res = await fetch(`${realtimeBase()}/api/realtime/upload-payslip`, {
    method: "POST",
    headers: { "X-Realtime-Secret": realtimeSecret() },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new Error(
      "Server Waschen Mobile menolak koneksi (secret tidak cocok). Samakan WASCHEN_MOBILE_REALTIME_SECRET di Alsa dengan SESSION_SECRET Waschen Mobile.",
    );
  }
  if (!res.ok || !json.file_path) {
    throw new Error(json.message || "Gagal mengunggah slip gaji ke server Waschen Mobile");
  }
  return json.file_path;
}

export async function deleteWaschenPayslipFile(filePath) {
  if (!filePath) return;
  try {
    await fetch(`${realtimeBase()}/api/realtime/delete-payslip`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Realtime-Secret": realtimeSecret() },
      body: JSON.stringify({ file_path: filePath }),
    });
  } catch (err) {
    console.warn("[deleteWaschenPayslipFile] skipped:", err.message);
  }
}

export async function fetchWaschenPayslipFile(filePath) {
  const name = String(filePath || "").split(/[/\\]/).pop();
  const res = await fetch(`${realtimeBase()}/api/realtime/payslip-file/${encodeURIComponent(name)}`, {
    headers: { "X-Realtime-Secret": realtimeSecret() },
  });
  if (!res.ok) {
    throw new Error("File slip gaji tidak ditemukan di server Waschen Mobile");
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: res.headers.get("content-type") || "application/octet-stream" };
}

/** Hapus file yang sudah terlanjur diunggah (dipakai saat transaksi DB gagal). */
export async function deleteWaschenMobileUpload(type, filePath) {
  if (!filePath) return;
  try {
    await fetch(`${realtimeBase()}/api/realtime/delete-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Realtime-Secret": realtimeSecret() },
      body: JSON.stringify({ type, filePath }),
    });
  } catch (err) {
    console.warn("[deleteWaschenMobileUpload] skipped:", err.message);
  }
}
