/**
 * Sumber tunggal master outlet untuk SELURUH Alora SuperApp: DB My Waschen (mst_outlet).
 * waschen.mst_outlet (DB utama) tidak dipakai lagi (2026-11-18).
 *
 * Query di DB utama (safeQuery) yang perlu nama outlet memakai JOIN lintas database:
 *   `LEFT JOIN ${mstOutlet()} o ON o.id = x.outlet_id`
 * Kedua DB ada di server MySQL yang sama dan diakses user yang sama.
 * Nama DB dibaca saat dipanggil (bukan saat import) supaya env sudah termuat.
 */
export function myWaschenDbName() {
  return process.env.DB_NAME_MY_WASCHEN || "my_waschen";
}

/** Nama tabel outlet lengkap dengan database, siap disisipkan ke SQL. */
export function mstOutlet() {
  return `\`${myWaschenDbName().replace(/`/g, "")}\`.mst_outlet`;
}

/**
 * Cek saat start: koneksi DB utama harus bisa membaca myWaschen.mst_outlet.
 * Gagal → log error jelas (menu Pengajuan, Aset, Dokumen, Operational, Academy butuh ini).
 */
export async function verifyOutletSource(safeQuery) {
  try {
    // Diam kalau berhasil; hanya log saat gagal
    await safeQuery(`SELECT 1 FROM ${mstOutlet()} LIMIT 1`);
  } catch (err) {
    console.error(
      `[outlet] GAGAL membaca ${mstOutlet()} dari koneksi DB utama: ${err.message}. ` +
        "Pastikan DB_NAME_MY_WASCHEN benar dan user DB utama punya akses SELECT ke DB My Waschen."
    );
  }
}
