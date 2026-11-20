/**
 * Foto kondisi item nota — bisa lebih dari 1 per item (tr_transaction_detail_photo).
 * tr_transaction_detail.photo_url tetap = foto pertama (sampul) untuk pembaca lama.
 *
 * File ini identik di my-waschen-new/api/utils, AloraSuperApp/backend/controllers/MyWaschen/utils
 * dan waschen-mobile/api/utils — ubah ketiganya bersamaan.
 * Migrasi: my-waschen-new/agent/migrate_item_photos.sql
 */

/** Batas foto per item (cukup untuk sisi depan/belakang/noda/label) */
export const MAX_ITEM_PHOTOS = 10;

const isMissingTable = (err) =>
  err?.code === "ER_NO_SUCH_TABLE" || /doesn't exist/i.test(err?.message || "");

/** Daftar URL unik dari payload item: photoUrls[] (baru) atau photoUrl (lama). */
export function collectPhotoUrls(item, isValid = () => true) {
  const raw = [item?.photoUrl, ...(Array.isArray(item?.photoUrls) ? item.photoUrls : [])];
  const out = [];
  for (const u of raw) {
    const s = String(u || "").trim();
    if (s && isValid(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_ITEM_PHOTOS);
}

/**
 * Foto per item. Tabel belum ada / item lama → pakai photo_url.
 * @param {(sql:string, params:any[]) => Promise<[any[]]>} query
 * @param {Array<{id:number, photo_url?:string}>} details
 * @returns {Promise<Record<number, Array<{id:number|string, photo_url:string}>>>}
 */
export async function loadItemPhotos(query, details) {
  const list = details || [];
  const byDetail = {};
  if (!list.length) return byDetail;
  const ids = list.map((d) => Number(d.id)).filter(Boolean);
  try {
    if (ids.length) {
      const [rows] = await query(
        `SELECT id, transaction_detail_id, photo_url, created_at
         FROM tr_transaction_detail_photo
         WHERE transaction_detail_id IN (?)
         ORDER BY transaction_detail_id ASC, id ASC`,
        [ids]
      );
      for (const r of rows || []) {
        (byDetail[r.transaction_detail_id] ||= []).push({
          id: r.id,
          photo_url: r.photo_url,
          created_at: r.created_at,
        });
      }
    }
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  // Fallback foto tunggal lama
  for (const d of list) {
    if (!byDetail[d.id]?.length && d.photo_url) {
      byDetail[d.id] = [{ id: `legacy-${d.id}`, photo_url: d.photo_url, created_at: null }];
    }
  }
  return byDetail;
}

/**
 * Simpan beberapa foto untuk satu item. Tabel belum ada → hanya foto pertama
 * yang tersimpan (di photo_url oleh pemanggil) dan dicatat di log.
 * @returns {Promise<number>} jumlah baris tersimpan
 */
export async function insertItemPhotos(conn, { transactionId, detailId, urls, uploadedBy = null }) {
  if (!urls?.length) return 0;
  try {
    await conn.query(
      `INSERT INTO tr_transaction_detail_photo (transaction_id, transaction_detail_id, photo_url, uploaded_by)
       VALUES ?`,
      [urls.map((u) => [transactionId, detailId, u, uploadedBy || null])]
    );
    return urls.length;
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.error(
      "[item-photo] tabel tr_transaction_detail_photo belum ada — jalankan agent/migrate_item_photos.sql. " +
        `Item ${detailId}: hanya foto pertama yang tersimpan (${urls.length} dikirim).`
    );
    return 0;
  }
}
