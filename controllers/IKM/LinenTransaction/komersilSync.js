import { safeIKMQuery } from "../../../db/pool.js";

// Formulir Linen Komersil berinduk — padanan api/utils/komersilChild.js di LMS (logika harus sama).
// Linen komersil = mst_hospital_linen.is_commercial = 1. Baris komersil formulir serah terima induk disalin ke
// formulir komersil anak (KODE-KOM-ddmmyy-NNN). Hanya washing_price_type M2 yang dipecah 1 baris per pcs (P × L).
// Skema (kolom is_commercial, parent_transaction_id, room_id, enum M2) dibuat oleh LMS saat start → deploy LMS dulu.

const q = (sql, params) => safeIKMQuery(sql, params);
const keyOf = (linenId, roomId) => `${Number(linenId)}|${roomId == null ? "null" : Number(roomId)}`;

/** Set hospital_linen_id yang komersil dari daftar id */
export async function commercialLinenIds(hospitalLinenIds) {
  const ids = [...new Set((hospitalLinenIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return new Set();
  const [rows] = await q(
    `SELECT id FROM mst_hospital_linen WHERE id IN (${ids.map(() => "?").join(",")}) AND COALESCE(is_commercial, 0) = 1`,
    ids
  );
  return new Set(rows.map(r => Number(r.id)));
}

async function childFormNumber(parentFormNumber) {
  const m = String(parentFormNumber).match(/^(.*)-(\d{6,8})-(\d+)$/);
  const base = m ? `${m[1]}-KOM-${m[2]}-${m[3]}` : `${parentFormNumber}-KOM`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const [[hit]] = await q("SELECT COUNT(*) AS n FROM tr_komersil_linen_transaction WHERE form_number = ?", [candidate]);
    if (!Number(hit.n)) return candidate;
  }
}

async function usedByKurangKirim(detailIds) {
  if (!detailIds.length) return new Set();
  const [rows] = await q(
    `SELECT DISTINCT komersil_detail_id AS id FROM tr_komersil_kurang_kirim_delivery_detail
      WHERE komersil_detail_id IN (${detailIds.map(() => "?").join(",")})`,
    detailIds
  );
  return new Set(rows.map(r => Number(r.id)));
}

/** Samakan formulir komersil anak dengan baris komersil induk. syncBersih = tulis bersih induk ke anak. */
export async function syncKomersilChild(parentId, { syncBersih = false } = {}) {
  const [[parent]] = await q("SELECT * FROM tr_linen_transaction WHERE id = ?", [parentId]);
  if (!parent) return null;

  const [groups] = await q(
    `SELECT d.hospital_linen_id, d.room_id,
            SUM(d.qty_kotor) AS kotor,
            SUM(d.qty_bersih) AS bersih, COUNT(d.qty_bersih) AS bersih_n,
            COALESCE(hl.washing_price_type, 'PCS') AS price_type,
            COALESCE(NULLIF(hl.hospital_linen_name, ''), l.linen_name) AS item_name
       FROM tr_linen_transaction_detail d
       INNER JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
       INNER JOIN mst_linen l ON l.id = hl.linen_id
      WHERE d.transaction_id = ? AND d.is_commercial = 1
      GROUP BY d.hospital_linen_id, d.room_id, hl.washing_price_type, hl.hospital_linen_name, l.linen_name
     HAVING kotor > 0`,
    [parentId]
  );

  let [[child]] = await q("SELECT * FROM tr_komersil_linen_transaction WHERE parent_transaction_id = ?", [parentId]);

  if (!groups.length) {
    if (!child) return null;
    const [[sj]] = await q("SELECT COUNT(*) AS n FROM tr_komersil_kurang_kirim_delivery WHERE transaction_id = ?", [child.id]);
    if (Number(sj.n)) {
      await q("UPDATE tr_komersil_linen_transaction_detail SET qty_kotor = 0 WHERE transaction_id = ?", [child.id]);
      return child.id;
    }
    await q("DELETE FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ?", [child.id]);
    await q("DELETE FROM tr_komersil_linen_transaction WHERE id = ?", [child.id]);
    return null;
  }

  const headerValues = [
    parent.hospital_id, parent.user_pickup, parent.user_delivery,
    parent.hospital_staff_pickup, parent.hospital_assistant_pickup,
    parent.hospital_staff_delivery, parent.hospital_assistant_delivery,
    parent.pickup_date, parent.delivery_date, parent.status, parent.completed_at ?? null,
    parent.notes_pickup, parent.notes_delivery
  ];
  if (!child) {
    const formNumber = await childFormNumber(parent.form_number);
    const [r] = await q(
      `INSERT INTO tr_komersil_linen_transaction
         (form_number, parent_transaction_id, hospital_id, user_pickup, user_delivery,
          hospital_staff_pickup, hospital_assistant_pickup, hospital_staff_delivery, hospital_assistant_delivery,
          pickup_date, delivery_date, status, completed_at, notes_pickup, notes_delivery, is_express)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [formNumber, parentId, ...headerValues, Number(parent.is_express) === 1 ? 1 : 0]
    );
    [[child]] = await q("SELECT * FROM tr_komersil_linen_transaction WHERE id = ?", [r.insertId]);
  } else {
    await q(
      `UPDATE tr_komersil_linen_transaction
          SET hospital_id = ?, user_pickup = ?, user_delivery = ?,
              hospital_staff_pickup = ?, hospital_assistant_pickup = ?,
              hospital_staff_delivery = ?, hospital_assistant_delivery = ?,
              pickup_date = ?, delivery_date = ?, status = ?, completed_at = ?,
              notes_pickup = ?, notes_delivery = ?
        WHERE id = ?`,
      [...headerValues, child.id]
    );
  }

  const [existing] = await q("SELECT * FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ? ORDER BY id", [child.id]);
  const byKey = new Map();
  for (const row of existing) {
    const k = keyOf(row.hospital_linen_id, row.room_id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(row);
  }
  const protectedIds = await usedByKurangKirim(existing.map(r => r.id));
  const removeRows = async (rows) => {
    for (const row of rows) {
      if (protectedIds.has(Number(row.id))) {
        await q("UPDATE tr_komersil_linen_transaction_detail SET qty_kotor = 0 WHERE id = ?", [row.id]);
      } else {
        await q("DELETE FROM tr_komersil_linen_transaction_detail WHERE id = ?", [row.id]);
      }
    }
  };

  const seen = new Set();
  for (const g of groups) {
    const k = keyOf(g.hospital_linen_id, g.room_id);
    seen.add(k);
    const rows = byKey.get(k) || [];
    const kotor = Number(g.kotor) || 0;
    const parentBersih = Number(g.bersih_n) > 0 ? Number(g.bersih) || 0 : null;
    const writeBersih = syncBersih && parentBersih !== null;

    if (g.price_type === "M2") {
      for (let i = 0; i < kotor; i++) {
        const bersih = writeBersih ? (i < parentBersih ? 1 : 0) : undefined;
        const row = rows[i];
        if (row) {
          await q(
            `UPDATE tr_komersil_linen_transaction_detail
                SET item_name = ?, qty_kotor = 1${bersih !== undefined ? ", qty_bersih = ?" : ""}
              WHERE id = ?`,
            bersih !== undefined ? [g.item_name, bersih, row.id] : [g.item_name, row.id]
          );
        } else {
          await q(
            `INSERT INTO tr_komersil_linen_transaction_detail
               (transaction_id, hospital_linen_id, room_id, item_name, qty_kotor, qty_bersih)
             VALUES (?, ?, ?, ?, 1, ?)`,
            [child.id, g.hospital_linen_id, g.room_id, g.item_name, bersih === undefined ? null : bersih]
          );
        }
      }
      await removeRows(rows.slice(kotor));
    } else {
      const [row, ...extra] = rows;
      if (row) {
        await q(
          `UPDATE tr_komersil_linen_transaction_detail
              SET item_name = ?, qty_kotor = ?${writeBersih ? ", qty_bersih = ?" : ""},
                  length_cm = NULL, width_cm = NULL, area_m2 = NULL
            WHERE id = ?`,
          writeBersih ? [g.item_name, kotor, parentBersih, row.id] : [g.item_name, kotor, row.id]
        );
      } else {
        await q(
          `INSERT INTO tr_komersil_linen_transaction_detail
             (transaction_id, hospital_linen_id, room_id, item_name, qty_kotor, qty_bersih)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [child.id, g.hospital_linen_id, g.room_id, g.item_name, kotor, writeBersih ? parentBersih : null]
        );
      }
      await removeRows(extra);
    }
  }
  for (const [k, rows] of byKey) {
    if (!seen.has(k)) await removeRows(rows);
  }
  return child.id;
}

/** Qty bersih formulir komersil → baris induk (per linen per ruangan) */
export async function pushKomersilBersihToParent(childId) {
  const [[child]] = await q("SELECT * FROM tr_komersil_linen_transaction WHERE id = ?", [childId]);
  if (!child?.parent_transaction_id) return;
  const parentId = child.parent_transaction_id;
  const [sums] = await q(
    `SELECT hospital_linen_id, room_id, SUM(qty_bersih) AS bersih, COUNT(qty_bersih) AS bersih_n
       FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ?
      GROUP BY hospital_linen_id, room_id`,
    [childId]
  );
  const [parentRows] = await q("SELECT * FROM tr_linen_transaction_detail WHERE transaction_id = ? ORDER BY id", [parentId]);
  for (const s of sums) {
    const rows = parentRows.filter(d => Number(d.is_commercial) === 1
      && keyOf(d.hospital_linen_id, d.room_id) === keyOf(s.hospital_linen_id, s.room_id));
    let remaining = Number(s.bersih_n) > 0 ? Number(s.bersih) || 0 : null;
    for (let i = 0; i < rows.length; i++) {
      let value = null;
      if (remaining !== null) {
        value = i === rows.length - 1 ? remaining : Math.min(remaining, Number(rows[i].qty_kotor) || 0);
        remaining -= value;
      }
      await q("UPDATE tr_linen_transaction_detail SET qty_bersih = ? WHERE id = ?", [value, rows[i].id]);
    }
  }
}

/** Hapus formulir komersil anak sebelum induknya dihapus (kecuali sudah ada surat jalan kurang kirim) */
export async function deleteKomersilChild(parentId) {
  const [[child]] = await q("SELECT id FROM tr_komersil_linen_transaction WHERE parent_transaction_id = ?", [parentId]);
  if (!child) return { ok: true };
  const [[sj]] = await q("SELECT COUNT(*) AS n FROM tr_komersil_kurang_kirim_delivery WHERE transaction_id = ?", [child.id]);
  if (Number(sj.n)) return { ok: false, message: "Formulir komersil anaknya sudah punya surat jalan kurang kirim; tidak dapat dihapus." };
  await q("DELETE FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ?", [child.id]);
  await q("DELETE FROM tr_komersil_linen_transaction_audit WHERE transaction_id = ?", [child.id]);
  await q("DELETE FROM tr_komersil_linen_transaction WHERE id = ?", [child.id]);
  return { ok: true };
}

/** Hasil hitung satu baris komersil: PCS = qty, KG = grammage × qty / 1000, M2 = luas */
export function komersilMeasure(row) {
  const type = row.washing_price_type || "PCS";
  const qty = Number(row.qty_bersih ?? row.qty_kotor) || 0;
  if (type === "KG") return { value: Math.round(((Number(row.grammage) || 0) * qty / 1000) * 100) / 100, unit: "Kg" };
  if (type === "M2") return { value: Number(row.area_m2) || 0, unit: "m²" };
  return { value: qty, unit: "Pcs" };
}
