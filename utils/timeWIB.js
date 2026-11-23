// Waktu WIB (UTC+7) yang TIDAK bergantung zona waktu server.
// toISOString() selalu UTC → "hari ini" jatuh ke kemarin antara 00:00–07:00 WIB dan jam tersimpan 7 jam lebih awal.
// Pakai helper ini untuk tanggal/jam yang disimpan atau dipakai sebagai default "hari ini".
const WIB_MS = 7 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" hari ini dalam WIB */
export const todayWIB = () => new Date(Date.now() + WIB_MS).toISOString().slice(0, 10);

/** "YYYY-MM-DD HH:mm:ss" sekarang dalam WIB (untuk kolom DATETIME) */
export const nowWIB = () => new Date(Date.now() + WIB_MS).toISOString().slice(0, 19).replace("T", " ");

/** Tambah/kurang hari pada "YYYY-MM-DD" (aman dari zona waktu) */
export const addDaysISO = (iso, days) => {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * Date yang getter lokalnya (getFullYear/getMonth/getDate/getHours) bernilai jam WIB,
 * untuk hitungan kalender (mis. periode cutoff 26–25). Jangan disimpan ke DB / dipakai getTime().
 */
export const wibNow = () => {
  const d = new Date();
  return new Date(d.getTime() + WIB_MS + d.getTimezoneOffset() * 60000);
};

/** Format Date hasil wibNow() (getter lokal) menjadi "YYYY-MM-DD" */
export const localDateISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
