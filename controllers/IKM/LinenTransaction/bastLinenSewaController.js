import { ikmPool, safeIKMQuery, safeQuery } from "../../../db/pool.js";

function bad(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function toTitleCase(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function assertTitleCase(label, value) {
  const raw = String(value || "").trim();
  if (!raw) throw bad(`${label} wajib diisi`);
  if (raw !== toTitleCase(raw)) throw bad(`${label} harus Capital Each Word`);
  if (raw.length > 150) throw bad(`${label} terlalu panjang`);
  return raw;
}

function assertText(label, value) {
  const raw = String(value || "").replace(/[<>]/g, "").trim();
  if (!raw) throw bad(`${label} wajib diisi`);
  if (raw.length > 150) throw bad(`${label} terlalu panjang`);
  return raw;
}

function readParties(body) {
  return {
    senderName: assertTitleCase("Nama pengirim", body.sender_name),
    senderPosition: assertText("Jabatan pengirim", body.sender_position),
    receiverName: assertTitleCase("Nama penerima", body.receiver_name),
    receiverPosition: assertText("Jabatan penerima", body.receiver_position),
    gaHeadName: assertTitleCase("Nama yang mengetahui", body.ga_head_name),
    gaHeadPosition: assertText("Jabatan yang mengetahui", body.ga_head_position),
  };
}

function parseDateTime(value) {
  const raw = String(value || "").trim().replace("T", " ");
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) throw bad("Tanggal tidak valid");
  const hh = Number(match[2] ?? 0);
  const mm = Number(match[3] ?? 0);
  const ss = Number(match[4] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) throw bad("Jam tidak valid");
  const pad = (n) => String(n).padStart(2, "0");
  return {
    date: match[1],
    dateTime: `${match[1]} ${pad(hh)}:${pad(mm)}:${pad(ss)}`,
  };
}

function parseQty(value, label) {
  if (value === "" || value == null) return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw bad(`${label} harus bilangan bulat 0 atau lebih`);
  return n;
}

function cleanNote(value) {
  if (value == null) return null;
  const s = String(value).replace(/[<>]/g, "").trim();
  return s ? s.slice(0, 255) : null;
}

function parseSignature(raw, label, required) {
  if (!raw) {
    if (required) throw bad(`${label} wajib diisi`);
    return null;
  }
  const s = String(raw).trim();
  const match = s.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw bad(`${label} harus gambar PNG atau JPEG`);
  const b64 = match[2].replace(/\s/g, "");
  if (b64.length < 32 || b64.length > 400000) throw bad(`${label} tidak valid atau terlalu besar`);
  return `data:image/${match[1]};base64,${b64}`;
}

async function senderNameFromSession(req) {
  if (req.session?.userEmail) {
    const [empRows] = await safeQuery(
      "SELECT full_name FROM mst_employee WHERE email = ? AND is_deleted = 0 LIMIT 1",
      [req.session.userEmail]
    );
    if (empRows[0]?.full_name) return empRows[0].full_name;
  }
  const [rows] = await safeQuery("SELECT name FROM users WHERE id = ? LIMIT 1", [req.session.userId]);
  return rows[0]?.name || req.session.userName || "";
}

async function assertRoom(conn, hospitalId, roomId) {
  if (!roomId) return null;
  const [rows] = await conn.query(
    "SELECT id FROM mst_rooms_rs WHERE id = ? AND hospital_id = ? LIMIT 1",
    [roomId, hospitalId]
  );
  if (!rows.length) throw bad("Ruangan tidak ditemukan di rumah sakit ini");
  return roomId;
}

async function lockLinen(conn, hospitalId, hospitalLinenId) {
  const [rows] = await conn.query(
    `SELECT id, hospital_linen_name, stock_in_rs, stock_in_ikm, ownership_type, is_active, is_commercial
     FROM mst_hospital_linen
     WHERE id = ? AND hospital_id = ?
     FOR UPDATE`,
    [hospitalLinenId, hospitalId]
  );
  const linen = rows[0];
  if (!linen || Number(linen.is_active) !== 1 || linen.ownership_type !== "SEWA" || Number(linen.is_commercial) === 1) {
    throw bad("Linen sewa tidak valid untuk rumah sakit ini");
  }
  return linen;
}

async function roomQty(conn, hospitalLinenId, roomId) {
  const [rows] = await conn.query(
    "SELECT stock_in_rs FROM mst_hospital_linen_rooms WHERE hospital_linen_id = ? AND room_id = ? FOR UPDATE",
    [hospitalLinenId, roomId]
  );
  return rows.length ? Number(rows[0].stock_in_rs) || 0 : null;
}

async function allocatedQty(conn, hospitalLinenId) {
  const [rows] = await conn.query(
    "SELECT COALESCE(SUM(stock_in_rs), 0) AS total FROM mst_hospital_linen_rooms WHERE hospital_linen_id = ?",
    [hospitalLinenId]
  );
  return Number(rows[0].total) || 0;
}

/**
 * delta = pengiriman - penarikan.
 * Ruangan: ubah stok ruangan dan total RS sebesar delta.
 * General: ubah total RS. Penarikan general hanya boleh dari stok yang belum masuk ruangan.
 * ponytail: lock per baris, bukan kunci satu RS. Aman untuk satu petugas; upgrade ke lock header RS kalau ada tabrakan stok.
 */
async function applyDelta(conn, { hospitalId, hospitalLinenId, roomId, delta, label }) {
  const linen = await lockLinen(conn, hospitalId, hospitalLinenId);
  const name = linen.hospital_linen_name || label || `Linen #${hospitalLinenId}`;
  const header = Number(linen.stock_in_rs) || 0;

  if (roomId) {
    const current = await roomQty(conn, hospitalLinenId, roomId);
    const base = current == null ? 0 : current;
    const nextRoom = base + delta;
    if (nextRoom < 0) throw bad(`Penarikan ${name} melebihi stok ruangan (${base})`);
    const nextHeader = header + delta;
    if (nextHeader < 0) throw bad(`Stok RS ${name} tidak cukup`);
    if (current == null) {
      await conn.query(
        "INSERT INTO mst_hospital_linen_rooms (hospital_linen_id, room_id, stock_in_rs) VALUES (?, ?, ?)",
        [hospitalLinenId, roomId, nextRoom]
      );
    } else {
      await conn.query(
        "UPDATE mst_hospital_linen_rooms SET stock_in_rs = ? WHERE hospital_linen_id = ? AND room_id = ?",
        [nextRoom, hospitalLinenId, roomId]
      );
    }
    await conn.query(
      "UPDATE mst_hospital_linen SET stock_in_rs = ?, current_stock = stock_in_ikm + ? WHERE id = ?",
      [nextHeader, nextHeader, hospitalLinenId]
    );
    return base;
  }

  const allocated = await allocatedQty(conn, hospitalLinenId);
  const free = header - allocated;
  if (header + delta < 0 || free + delta < 0) {
    throw bad(`Penarikan ${name} melebihi stok umum yang belum berada di ruangan (${Math.max(free, 0)}). Pilih ruangan untuk menarik stok yang sudah di ruangan.`);
  }
  const nextHeader = header + delta;
  await conn.query(
    "UPDATE mst_hospital_linen SET stock_in_rs = ?, current_stock = stock_in_ikm + ? WHERE id = ?",
    [nextHeader, nextHeader, hospitalLinenId]
  );
  return header;
}

function normalizeLines(details) {
  if (!Array.isArray(details)) throw bad("Detail linen tidak valid");
  const seen = new Set();
  const lines = [];
  for (const row of details) {
    const hospitalLinenId = Number(row.hospital_linen_id);
    if (!Number.isInteger(hospitalLinenId) || hospitalLinenId <= 0) throw bad("Linen tidak valid");
    const roomId = row.room_id === null || row.room_id === undefined || row.room_id === "" ? null : Number(row.room_id);
    if (roomId !== null && (!Number.isInteger(roomId) || roomId <= 0)) throw bad("Ruangan tidak valid");
    const key = `${hospitalLinenId}:${roomId || 0}`;
    if (seen.has(key)) throw bad("Linen tidak boleh dobel dalam satu ruangan");
    seen.add(key);
    const kirim = parseQty(row.qty_pengiriman, "Pengiriman");
    const tarik = parseQty(row.qty_penarikan, "Penarikan");
    if (kirim === 0 && tarik === 0) continue;
    lines.push({
      hospital_linen_id: hospitalLinenId,
      room_id: roomId,
      qty_pengiriman: kirim,
      qty_penarikan: tarik,
      notes: cleanNote(row.notes),
    });
  }
  if (!lines.length) throw bad("Isi minimal satu pengiriman atau penarikan");
  return lines;
}

function singleRoomId(lines) {
  const ids = [...new Set(lines.map((line) => line.room_id || null))];
  return ids.length === 1 ? ids[0] : null;
}

function storedRoom(line, headerRoom) {
  return line.room_id != null && line.room_id !== "" ? Number(line.room_id) : headerRoom;
}

async function assertLineRooms(conn, hospitalId, lines) {
  for (const room of new Set(lines.map((line) => line.room_id).filter(Boolean))) {
    await assertRoom(conn, hospitalId, room);
  }
}

async function withTx(work) {
  const conn = await ikmPool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function linenDisplayName(row) {
  const custom = String(row.hospital_linen_name || "").trim();
  if (custom) return custom;
  const parts = [row.master_linen_name, row.size_name, row.color_name, row.material_name].filter(Boolean);
  return parts.join(" ") || `Linen #${row.hospital_linen_id}`;
}

function sendError(res, err) {
  if (err.status === 400) return res.status(400).json({ success: false, message: err.message });
  console.error("bast linen sewa:", err);
  if (err.code === "ER_NO_SUCH_TABLE") {
    return res.status(500).json({ success: false, message: "Tabel BAST belum tersedia. Skema database belum dijalankan." });
  }
  return res.status(500).json({ success: false, message: "Gagal memproses BAST" });
}

export const getSenderDefault = async (req, res) => {
  try {
    const name = await senderNameFromSession(req);
    res.json({ success: true, data: { sender_name: toTitleCase(name) } });
  } catch (err) {
    sendError(res, err);
  }
};

export const getFormLinens = async (req, res) => {
  try {
    const hospitalId = Number(req.query.hospital_id);
    const roomId = req.query.room_id ? Number(req.query.room_id) : null;
    const bastId = req.query.bast_id ? Number(req.query.bast_id) : null;
    if (!hospitalId) throw bad("Rumah sakit wajib dipilih");

    const [rows] = await safeIKMQuery(
      `SELECT hl.id AS hospital_linen_id,
              hl.hospital_linen_name,
              l.linen_name AS master_linen_name,
              sz.size_name, cl.color_name, mt.material_name,
              hl.stock_in_ikm AS stock_ikm,
              hl.stock_in_rs AS stock_rs,
              COALESCE(rm.stock_in_rs, 0) AS stock_room,
              CASE WHEN rm.hospital_linen_id IS NULL THEN 0 ELSE 1 END AS mapped_room
       FROM mst_hospital_linen hl
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       LEFT JOIN mst_hospital_linen_rooms rm
         ON rm.hospital_linen_id = hl.id AND rm.room_id = ?
       WHERE hl.hospital_id = ?
         AND hl.is_active = 1
         AND hl.ownership_type = 'SEWA'
         AND COALESCE(hl.is_commercial, 0) = 0
         AND (? IS NULL OR rm.hospital_linen_id IS NOT NULL)
       ORDER BY l.linen_name ASC, sz.size_name ASC`,
      [roomId || 0, hospitalId, roomId]
    );

    let adjust = new Map();
    if (bastId) {
      const [oldRows] = await safeIKMQuery(
        `SELECT d.hospital_linen_id, d.qty_pengiriman, d.qty_penarikan,
                COALESCE(d.room_id, b.room_id) AS room_id
         FROM tr_bast_linen_sewa_detail d
         JOIN tr_bast_linen_sewa b ON b.id = d.bast_id
         WHERE d.bast_id = ? AND b.hospital_id = ?`,
        [bastId, hospitalId]
      );
      for (const r of oldRows) {
        const id = Number(r.hospital_linen_id);
        const delta = Number(r.qty_pengiriman) - Number(r.qty_penarikan);
        const cur = adjust.get(id) || { hospital: 0, room: 0 };
        cur.hospital += delta;
        if (roomId && Number(r.room_id) === Number(roomId)) cur.room += delta;
        adjust.set(id, cur);
      }
    }

    const data = rows.map((row) => {
      const live = roomId ? Number(row.stock_room) || 0 : Number(row.stock_rs) || 0;
      const old = adjust.get(Number(row.hospital_linen_id));
      const stock = live - (roomId ? old?.room || 0 : old?.hospital || 0);
      return {
        hospital_linen_id: row.hospital_linen_id,
        linen_name: linenDisplayName(row),
        stock_ikm: Number(row.stock_ikm) || 0,
        stock_rs: stock,
        qty_pengiriman: 0,
        qty_penarikan: 0,
        notes: "",
      };
    });
    const roomQuery = await safeIKMQuery(
      "SELECT id, room_name FROM mst_rooms_rs WHERE hospital_id = ? ORDER BY room_name ASC",
      [hospitalId]
    );
    res.json({ success: true, data, rooms: roomQuery[0] });
  } catch (err) {
    sendError(res, err);
  }
};

export const listBast = async (req, res) => {
  try {
    const hospitalId = Number(req.query.hospital_id);
    if (!hospitalId) throw bad("Rumah sakit wajib dipilih");
    const day = (value) => {
      const s = String(value || "").trim();
      if (!s) return "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad("Format tanggal tidak valid");
      return s;
    };
    const startDate = day(req.query.start_date);
    const endDate = day(req.query.end_date);
    const where = ["b.hospital_id = ?"];
    const params = [hospitalId];
    if (startDate) { where.push("DATE(b.bast_date) >= ?"); params.push(startDate); }
    if (endDate) { where.push("DATE(b.bast_date) <= ?"); params.push(endDate); }
    const [rows] = await safeIKMQuery(
      `SELECT b.id, b.bast_number, b.hospital_id, b.room_id,
              DATE_FORMAT(b.bast_date, '%Y-%m-%d %H:%i:%s') AS bast_date,
              b.sender_name, b.sender_position, COALESCE(b.receiver_name, b.rs_inspector_name) AS receiver_name, b.receiver_position, b.ga_head_name, b.ga_head_position,
              CASE
                WHEN COUNT(DISTINCT IFNULL(COALESCE(d.room_id, b.room_id), 0)) > 1 THEN 'Beberapa Unit'
                ELSE COALESCE(MAX(rd.room_name), r.room_name)
              END AS room_name,
              COALESCE(SUM(d.qty_pengiriman), 0) AS total_pengiriman,
              COALESCE(SUM(d.qty_penarikan), 0) AS total_penarikan
       FROM tr_bast_linen_sewa b
       LEFT JOIN mst_rooms_rs r ON r.id = b.room_id
       LEFT JOIN tr_bast_linen_sewa_detail d ON d.bast_id = b.id
       LEFT JOIN mst_rooms_rs rd ON rd.id = d.room_id
       WHERE ${where.join(" AND ")}
       GROUP BY b.id, b.bast_number, b.hospital_id, b.room_id, b.bast_date,
                b.sender_name, b.sender_position, b.receiver_name, b.receiver_position, b.ga_head_name, b.ga_head_position, b.rs_inspector_name, r.room_name
       ORDER BY b.bast_date DESC, b.id DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    sendError(res, err);
  }
};

export const getBast = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [headers] = await safeIKMQuery(
      `SELECT b.id, b.bast_number, b.hospital_id, b.room_id,
              DATE_FORMAT(b.bast_date, '%Y-%m-%d %H:%i:%s') AS bast_date,
              b.sender_name, b.sender_position, COALESCE(b.receiver_name, b.rs_inspector_name) AS receiver_name,
              b.receiver_position, b.ga_head_name, b.ga_head_position, b.signature_sender,
              COALESCE(b.signature_receiver, b.signature_inspector) AS signature_receiver, b.signature_ga,
              b.created_by_name, b.created_at, b.updated_at, r.room_name, h.hospital_name
       FROM tr_bast_linen_sewa b
       JOIN mst_hospital h ON h.id = b.hospital_id
       LEFT JOIN mst_rooms_rs r ON r.id = b.room_id
       WHERE b.id = ?`,
      [id]
    );
    if (!headers.length) return res.status(404).json({ success: false, message: "BAST tidak ditemukan" });
    const [details] = await safeIKMQuery(
      `SELECT d.id, d.hospital_linen_id, d.room_id, d.stock_before, d.qty_pengiriman, d.qty_penarikan, d.notes,
              d.ukuran, d.bahan, d.warna,
              hl.hospital_linen_name, l.linen_name AS master_linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM tr_bast_linen_sewa_detail d
       LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE d.bast_id = ?
       ORDER BY l.linen_name ASC, sz.size_name ASC`,
      [id]
    );
    res.json({
      success: true,
      data: { ...headers[0], details: details.map((row) => ({ ...row, linen_name: linenDisplayName(row) })) },
    });
  } catch (err) {
    sendError(res, err);
  }
};

async function nextNumber(conn, hospitalId, dateOnly) {
  const [hosp] = await conn.query("SELECT hospital_id FROM mst_hospital WHERE id = ? LIMIT 1", [hospitalId]);
  const code = String(hosp[0]?.hospital_id || hospitalId).replace(/[^\w-]/g, "").slice(0, 12) || hospitalId;
  const ymd = dateOnly.replace(/-/g, "");
  const prefix = `BAST-${code}-${ymd}-`;
  const [rows] = await conn.query(
    "SELECT COUNT(*) AS cnt FROM tr_bast_linen_sewa WHERE hospital_id = ? AND DATE(bast_date) = ? FOR UPDATE",
    [hospitalId, dateOnly]
  );
  return `${prefix}${String(Number(rows[0].cnt) + 1).padStart(3, "0")}`;
}

async function readHeader(conn, id) {
  const [rows] = await conn.query("SELECT * FROM tr_bast_linen_sewa WHERE id = ? FOR UPDATE", [id]);
  if (!rows.length) throw bad("BAST tidak ditemukan");
  return rows[0];
}

async function readDetails(conn, id) {
  const [rows] = await conn.query(
    "SELECT hospital_linen_id, room_id, qty_pengiriman, qty_penarikan, notes FROM tr_bast_linen_sewa_detail WHERE bast_id = ?",
    [id]
  );
  return rows;
}

function bastSnap(header, lines) {
  const details = lines.map((line) => ({
    hospital_linen_id: Number(line.hospital_linen_id),
    room_id: line.room_id ? Number(line.room_id) : null,
    qty_pengiriman: Number(line.qty_pengiriman) || 0,
    qty_penarikan: Number(line.qty_penarikan) || 0,
    notes: line.notes || "",
  })).sort((a, b) => a.hospital_linen_id - b.hospital_linen_id || (a.room_id || 0) - (b.room_id || 0));
  return {
    room_id: header.room_id ? Number(header.room_id) : null,
    bast_date: String(header.bast_date || "").replace("T", " ").slice(0, 19),
    sender_name: header.sender_name || "",
    sender_position: header.sender_position || "",
    receiver_name: header.receiver_name || header.rs_inspector_name || "",
    receiver_position: header.receiver_position || "",
    ga_head_name: header.ga_head_name || "",
    ga_head_position: header.ga_head_position || "",
    has_signature_sender: Boolean(header.signature_sender),
    has_signature_receiver: Boolean(header.signature_receiver || header.signature_inspector),
    has_signature_ga: Boolean(header.signature_ga),
    details,
  };
}

function changedFields(before, after) {
  const fields = ["room_id", "bast_date", "sender_name", "sender_position", "receiver_name", "receiver_position", "ga_head_name", "ga_head_position", "has_signature_sender", "has_signature_receiver", "has_signature_ga"];
  const changed = fields.filter((key) => String(before[key] ?? "") !== String(after[key] ?? ""));
  if (JSON.stringify(before.details) !== JSON.stringify(after.details)) changed.push("details");
  return changed;
}

async function writeBastLog(conn, { bastId, bastNumber, action, actorName, actorUserId, changes }) {
  await conn.query(
    `INSERT INTO tr_bast_linen_sewa_log
      (bast_id, bast_number, action, actor_name, actor_user_id, changes_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [bastId || null, bastNumber || null, action, String(actorName || "Sistem").slice(0, 150), actorUserId || null, JSON.stringify(changes)]
  );
}

export const createBast = async (req, res) => {
  try {
    const hospitalId = Number(req.body.hospital_id);
    if (!hospitalId) throw bad("Rumah sakit wajib dipilih");
    const { date, dateTime } = parseDateTime(req.body.bast_date);
    const parties = readParties(req.body);
    const signatureSender = parseSignature(req.body.signature_sender, "Tanda tangan pihak kedua", false);
    const signatureReceiver = parseSignature(req.body.signature_receiver, "Tanda tangan pihak pertama", false);
    const signatureGa = parseSignature(req.body.signature_ga, "Tanda tangan kepala divisi GA", false);
    const lines = normalizeLines(req.body.details);
    const docRoom = singleRoomId(lines);
    const actorName = toTitleCase(await senderNameFromSession(req)) || parties.senderName;
    const actorUserId = Number(req.session?.userId) || null;

    const id = await withTx(async (conn) => {
      await assertLineRooms(conn, hospitalId, lines);
      const number = await nextNumber(conn, hospitalId, date);
      const [result] = await conn.query(
        `INSERT INTO tr_bast_linen_sewa
         (bast_number, hospital_id, room_id, bast_date, sender_name, sender_position,
          receiver_name, receiver_position, ga_head_name, ga_head_position, rs_inspector_name,
          signature_sender, signature_receiver, signature_ga, signature_inspector, created_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [number, hospitalId, docRoom, dateTime, parties.senderName, parties.senderPosition, parties.receiverName, parties.receiverPosition, parties.gaHeadName, parties.gaHeadPosition, parties.receiverName, signatureSender, signatureReceiver, signatureGa, signatureReceiver, actorName]
      );
      const bastId = result.insertId;
      for (const line of lines) {
        const stockBefore = await applyDelta(conn, {
          hospitalId,
          hospitalLinenId: line.hospital_linen_id,
          roomId: line.room_id,
          delta: line.qty_pengiriman - line.qty_penarikan,
          label: `Linen #${line.hospital_linen_id}`,
        });
        await conn.query(
          `INSERT INTO tr_bast_linen_sewa_detail
           (bast_id, hospital_linen_id, room_id, stock_before, qty_pengiriman, qty_penarikan, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [bastId, line.hospital_linen_id, line.room_id, stockBefore, line.qty_pengiriman, line.qty_penarikan, line.notes]
        );
      }
      await writeBastLog(conn, {
        bastId,
        bastNumber: number,
        action: "CREATE",
        actorName,
        actorUserId,
        changes: {
          after: bastSnap({
            room_id: docRoom,
            bast_date: dateTime,
            sender_name: parties.senderName,
            sender_position: parties.senderPosition,
            receiver_name: parties.receiverName,
            receiver_position: parties.receiverPosition,
            ga_head_name: parties.gaHeadName,
            ga_head_position: parties.gaHeadPosition,
            signature_sender: signatureSender,
            signature_receiver: signatureReceiver,
            signature_ga: signatureGa,
          }, lines),
        },
      });
      return bastId;
    });
    res.json({ success: true, message: "BAST berhasil disimpan", id });
  } catch (err) {
    sendError(res, err);
  }
};

export const updateBast = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const hospitalId = Number(req.body.hospital_id);
    if (!hospitalId) throw bad("Rumah sakit wajib dipilih");
    const { dateTime } = parseDateTime(req.body.bast_date);
    const parties = readParties(req.body);
    const lines = normalizeLines(req.body.details);
    const docRoom = singleRoomId(lines);
    const actorName = toTitleCase(await senderNameFromSession(req)) || "Sistem";
    const actorUserId = Number(req.session?.userId) || null;

    await withTx(async (conn) => {
      const header = await readHeader(conn, id);
      if (Number(header.hospital_id) !== hospitalId) throw bad("BAST bukan milik rumah sakit ini");
      await assertLineRooms(conn, hospitalId, lines);
      const oldRoom = header.room_id ? Number(header.room_id) : null;
      const oldLines = await readDetails(conn, id);
      const before = bastSnap(header, oldLines);
      for (const line of oldLines) {
        await applyDelta(conn, {
          hospitalId,
          hospitalLinenId: Number(line.hospital_linen_id),
          roomId: storedRoom(line, oldRoom),
          delta: Number(line.qty_penarikan) - Number(line.qty_pengiriman),
        });
      }
      const signatureSender = parseSignature(req.body.signature_sender, "Tanda tangan pihak kedua", false);
      const signatureReceiver = parseSignature(req.body.signature_receiver, "Tanda tangan pihak pertama", false);
      const signatureGa = parseSignature(req.body.signature_ga, "Tanda tangan kepala divisi GA", false);
      await conn.query(
        `UPDATE tr_bast_linen_sewa
         SET room_id = ?, bast_date = ?, sender_name = ?, sender_position = ?,
             receiver_name = ?, receiver_position = ?, ga_head_name = ?, ga_head_position = ?, rs_inspector_name = ?,
             signature_sender = COALESCE(?, signature_sender),
             signature_receiver = COALESCE(?, signature_receiver, signature_inspector),
             signature_ga = COALESCE(?, signature_ga),
             signature_inspector = COALESCE(?, signature_inspector)
         WHERE id = ?`,
        [docRoom, dateTime, parties.senderName, parties.senderPosition, parties.receiverName, parties.receiverPosition, parties.gaHeadName, parties.gaHeadPosition, parties.receiverName, signatureSender, signatureReceiver, signatureGa, signatureReceiver, id]
      );
      const [keptSpecs] = await conn.query(
        "SELECT hospital_linen_id, room_id, ukuran, bahan, warna FROM tr_bast_linen_sewa_detail WHERE bast_id = ?",
        [id]
      );
      const specByLine = new Map(keptSpecs.map((row) => [`${row.hospital_linen_id}:${row.room_id || 0}`, row]));
      await conn.query("DELETE FROM tr_bast_linen_sewa_detail WHERE bast_id = ?", [id]);
      for (const line of lines) {
        const stockBefore = await applyDelta(conn, {
          hospitalId,
          hospitalLinenId: line.hospital_linen_id,
          roomId: line.room_id,
          delta: line.qty_pengiriman - line.qty_penarikan,
        });
        const spec = specByLine.get(`${line.hospital_linen_id}:${line.room_id || 0}`) || {};
        await conn.query(
          `INSERT INTO tr_bast_linen_sewa_detail
           (bast_id, hospital_linen_id, room_id, stock_before, qty_pengiriman, qty_penarikan, notes, ukuran, bahan, warna)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, line.hospital_linen_id, line.room_id, stockBefore, line.qty_pengiriman, line.qty_penarikan, line.notes, spec.ukuran || null, spec.bahan || null, spec.warna || null]
        );
      }
      const after = bastSnap({
        room_id: docRoom,
        bast_date: dateTime,
        sender_name: parties.senderName,
        sender_position: parties.senderPosition,
        receiver_name: parties.receiverName,
        receiver_position: parties.receiverPosition,
        ga_head_name: parties.gaHeadName,
        ga_head_position: parties.gaHeadPosition,
        signature_sender: signatureSender || header.signature_sender,
        signature_receiver: signatureReceiver || header.signature_receiver || header.signature_inspector,
        signature_ga: signatureGa || header.signature_ga,
      }, lines);
      await writeBastLog(conn, {
        bastId: id,
        bastNumber: header.bast_number,
        action: "UPDATE",
        actorName,
        actorUserId,
        changes: { changed: changedFields(before, after), before, after },
      });
    });
    res.json({ success: true, message: "BAST berhasil diperbarui" });
  } catch (err) {
    sendError(res, err);
  }
};

export const deleteBast = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const actorName = toTitleCase(await senderNameFromSession(req)) || "Sistem";
    const actorUserId = Number(req.session?.userId) || null;
    await withTx(async (conn) => {
      const header = await readHeader(conn, id);
      const oldRoom = header.room_id ? Number(header.room_id) : null;
      const oldLines = await readDetails(conn, id);
      await writeBastLog(conn, {
        bastId: id,
        bastNumber: header.bast_number,
        action: "DELETE",
        actorName,
        actorUserId,
        changes: { before: bastSnap(header, oldLines) },
      });
      for (const line of oldLines) {
        await applyDelta(conn, {
          hospitalId: Number(header.hospital_id),
          hospitalLinenId: Number(line.hospital_linen_id),
          roomId: storedRoom(line, oldRoom),
          delta: Number(line.qty_penarikan) - Number(line.qty_pengiriman),
        });
      }
      await conn.query("DELETE FROM tr_bast_linen_sewa_detail WHERE bast_id = ?", [id]);
      await conn.query("DELETE FROM tr_bast_linen_sewa WHERE id = ?", [id]);
    });
    res.json({ success: true, message: "BAST berhasil dihapus" });
  } catch (err) {
    sendError(res, err);
  }
};

function optionalLabel(value) {
  const raw = String(value ?? "").replace(/[<>]/g, "").trim();
  if (raw.length > 100) throw bad("Ukuran, bahan, atau warna terlalu panjang");
  return raw || null;
}

export const updateLineSpecs = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!id || !lines.length) throw bad("Tidak ada baris yang diubah");
    const [headers] = await safeIKMQuery("SELECT id FROM tr_bast_linen_sewa WHERE id = ? LIMIT 1", [id]);
    if (!headers.length) return res.status(404).json({ success: false, message: "BAST tidak ditemukan" });
    for (const line of lines) {
      const lineId = Number(line.id);
      if (!lineId) throw bad("Baris linen tidak valid");
      const [found] = await safeIKMQuery("SELECT id FROM tr_bast_linen_sewa_detail WHERE id = ? AND bast_id = ? LIMIT 1", [lineId, id]);
      if (!found.length) throw bad("Baris linen tidak ditemukan");
      await safeIKMQuery(
        "UPDATE tr_bast_linen_sewa_detail SET ukuran = ?, bahan = ?, warna = ? WHERE id = ? AND bast_id = ?",
        [optionalLabel(line.ukuran), optionalLabel(line.bahan), optionalLabel(line.warna), lineId, id]
      );
    }
    res.json({ success: true, message: "Keterangan linen diperbarui" });
  } catch (err) {
    sendError(res, err);
  }
};
