import { safeMyWaschenQuery } from "../../../db/pool.js";

function toTimeStr(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const m = v.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return `${String(m[1]).padStart(2, "0")}:${m[2]}:${m[3] || "00"}`;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const h = String(v.getHours()).padStart(2, "0");
    const mi = String(v.getMinutes()).padStart(2, "0");
    const s = String(v.getSeconds()).padStart(2, "0");
    return `${h}:${mi}:${s}`;
  }
  return null;
}

function flag(v, def = 0) {
  if (v === undefined || v === null || v === "") return def;
  return Number(v) ? 1 : 0;
}

function normalizeAttendance(row) {
  if (!row) return null;
  return {
    ...row,
    open_time: toTimeStr(row.open_time),
    close_time: toTimeStr(row.close_time),
    lock_start_time: toTimeStr(row.lock_start_time),
    lock_end_time: toTimeStr(row.lock_end_time),
    work_date_cutoff_time: toTimeStr(row.work_date_cutoff_time),
    after_midnight_open: Number(row.after_midnight_open) ? 1 : 0,
    lock_enabled: Number(row.lock_enabled) ? 1 : 0,
    is_active: Number(row.is_active) ? 1 : 0,
  };
}

function normalizeGrooming(row) {
  if (!row) return null;
  return {
    ...row,
    window1_start: toTimeStr(row.window1_start),
    window1_end: toTimeStr(row.window1_end),
    window2_start: toTimeStr(row.window2_start),
    window2_end: toTimeStr(row.window2_end),
    lock_after_time: toTimeStr(row.lock_after_time),
    feature_enabled: Number(row.feature_enabled) ? 1 : 0,
    window2_enabled: Number(row.window2_enabled) ? 1 : 0,
    lock_enabled: Number(row.lock_enabled) ? 1 : 0,
    require_reason_after_lock: Number(row.require_reason_after_lock) ? 1 : 0,
    is_active: Number(row.is_active) ? 1 : 0,
  };
}

function normalizeShift(row) {
  if (!row) return null;
  return {
    ...row,
    open_time: toTimeStr(row.open_time),
    close_time: toTimeStr(row.close_time),
    shift_number: Number(row.shift_number),
    remind_open: Number(row.remind_open) ? 1 : 0,
    remind_close: Number(row.remind_close) ? 1 : 0,
    enforce_open: Number(row.enforce_open) ? 1 : 0,
    enforce_close: Number(row.enforce_close) ? 1 : 0,
    is_active: Number(row.is_active) ? 1 : 0,
    sort_order: Number(row.sort_order) || 0,
  };
}

/** Bundle aktif untuk Mobile / POS */
export const getActiveTimeConfig = async (_req, res) => {
  try {
    const [[att]] = await safeMyWaschenQuery(
      `SELECT * FROM mst_time_attendance WHERE is_active = 1 ORDER BY id ASC LIMIT 1`,
    );
    const [[groom]] = await safeMyWaschenQuery(
      `SELECT * FROM mst_time_grooming WHERE is_active = 1 ORDER BY id ASC LIMIT 1`,
    );
    const [shifts] = await safeMyWaschenQuery(
      `SELECT * FROM mst_time_shift WHERE is_active = 1 ORDER BY sort_order ASC, shift_number ASC`,
    );
    return res.json({
      success: true,
      data: {
        attendance: normalizeAttendance(att || null),
        grooming: normalizeGrooming(groom || null),
        shifts: (shifts || []).map(normalizeShift),
      },
    });
  } catch (err) {
    console.error("getActiveTimeConfig:", err);
    if (err.code === "ER_NO_SUCH_TABLE") {
      return res.status(500).json({
        success: false,
        message: "Tabel master jam belum tersedia. Jalankan agent/mst_time_attendance_grooming_shift.sql",
      });
    }
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat konfigurasi jam" });
  }
};

export const listAttendanceTimes = async (_req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(`SELECT * FROM mst_time_attendance ORDER BY id ASC`);
    return res.json({ success: true, data: rows.map(normalizeAttendance) });
  } catch (err) {
    console.error("listAttendanceTimes:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const listGroomingTimes = async (_req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(`SELECT * FROM mst_time_grooming ORDER BY id ASC`);
    return res.json({ success: true, data: rows.map(normalizeGrooming) });
  } catch (err) {
    console.error("listGroomingTimes:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const listShiftTimes = async (_req, res) => {
  try {
    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_time_shift ORDER BY sort_order ASC, shift_number ASC, id ASC`,
    );
    return res.json({ success: true, data: rows.map(normalizeShift) });
  } catch (err) {
    console.error("listShiftTimes:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const upsertAttendanceTime = async (req, res) => {
  try {
    const id = req.params.id ? Number(req.params.id) : null;
    const body = req.body || {};
    const code = String(body.code || "default").trim().toLowerCase() || "default";
    const name = String(body.name || "Jam Absensi").trim();
    const open_time = toTimeStr(body.open_time);
    const close_time = toTimeStr(body.close_time);
    const lock_start_time = toTimeStr(body.lock_start_time);
    const lock_end_time = toTimeStr(body.lock_end_time);
    const work_date_cutoff_time = toTimeStr(body.work_date_cutoff_time);
    if (!open_time || !close_time || !lock_start_time || !lock_end_time || !work_date_cutoff_time) {
      return res.status(422).json({ success: false, message: "Semua jam absensi wajib diisi (HH:mm)" });
    }

    const payload = [
      code,
      name,
      open_time,
      close_time,
      flag(body.after_midnight_open, 1),
      flag(body.lock_enabled, 1),
      lock_start_time,
      lock_end_time,
      work_date_cutoff_time,
      flag(body.is_active, 1),
      body.notes ? String(body.notes).slice(0, 255) : null,
    ];

    if (id) {
      await safeMyWaschenQuery(
        `UPDATE mst_time_attendance SET
          code=?, name=?, open_time=?, close_time=?, after_midnight_open=?,
          lock_enabled=?, lock_start_time=?, lock_end_time=?, work_date_cutoff_time=?,
          is_active=?, notes=?
         WHERE id=?`,
        [...payload, id],
      );
    } else {
      const [result] = await safeMyWaschenQuery(
        `INSERT INTO mst_time_attendance
          (code, name, open_time, close_time, after_midnight_open,
           lock_enabled, lock_start_time, lock_end_time, work_date_cutoff_time,
           is_active, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        payload,
      );
      return res.status(201).json({ success: true, message: "Jam absensi ditambahkan", data: { id: result.insertId } });
    }

    const [rows] = await safeMyWaschenQuery(`SELECT * FROM mst_time_attendance WHERE id=?`, [id]);
    return res.json({ success: true, message: "Jam absensi diperbarui", data: normalizeAttendance(rows[0]) });
  } catch (err) {
    console.error("upsertAttendanceTime:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Kode jam absensi sudah dipakai" });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const upsertGroomingTime = async (req, res) => {
  try {
    const id = req.params.id ? Number(req.params.id) : null;
    const body = req.body || {};
    const code = String(body.code || "default").trim().toLowerCase() || "default";
    const name = String(body.name || "Jam Grooming").trim();
    const window1_start = toTimeStr(body.window1_start);
    const window1_end = toTimeStr(body.window1_end);
    const lock_after_time = toTimeStr(body.lock_after_time);
    const window2_enabled = flag(body.window2_enabled, 1);
    const window2_start = window2_enabled ? toTimeStr(body.window2_start) : null;
    const window2_end = window2_enabled ? toTimeStr(body.window2_end) : null;

    if (!window1_start || !window1_end || !lock_after_time) {
      return res.status(422).json({ success: false, message: "Jendela 1 dan jam kunci grooming wajib diisi" });
    }
    if (window2_enabled && (!window2_start || !window2_end)) {
      return res.status(422).json({ success: false, message: "Jendela 2 aktif — jam mulai/selesai wajib diisi" });
    }

    const payload = [
      code,
      name,
      flag(body.feature_enabled, 1),
      window1_start,
      window1_end,
      window2_enabled,
      window2_start,
      window2_end,
      flag(body.lock_enabled, 1),
      lock_after_time,
      flag(body.require_reason_after_lock, 1),
      flag(body.is_active, 1),
      body.notes ? String(body.notes).slice(0, 255) : null,
    ];

    if (id) {
      await safeMyWaschenQuery(
        `UPDATE mst_time_grooming SET
          code=?, name=?, feature_enabled=?,
          window1_start=?, window1_end=?, window2_enabled=?, window2_start=?, window2_end=?,
          lock_enabled=?, lock_after_time=?, require_reason_after_lock=?,
          is_active=?, notes=?
         WHERE id=?`,
        [...payload, id],
      );
      const [rows] = await safeMyWaschenQuery(`SELECT * FROM mst_time_grooming WHERE id=?`, [id]);
      return res.json({ success: true, message: "Jam grooming diperbarui", data: normalizeGrooming(rows[0]) });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_time_grooming
        (code, name, feature_enabled, window1_start, window1_end, window2_enabled, window2_start, window2_end,
         lock_enabled, lock_after_time, require_reason_after_lock, is_active, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload,
    );
    return res.status(201).json({ success: true, message: "Jam grooming ditambahkan", data: { id: result.insertId } });
  } catch (err) {
    console.error("upsertGroomingTime:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Kode jam grooming sudah dipakai" });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const upsertShiftTime = async (req, res) => {
  try {
    const id = req.params.id ? Number(req.params.id) : null;
    const body = req.body || {};
    const shift_number = Number(body.shift_number);
    const code = String(body.code || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const open_time = toTimeStr(body.open_time);
    const close_time = toTimeStr(body.close_time);

    if (!shift_number || !code || !name || !open_time || !close_time) {
      return res.status(422).json({ success: false, message: "Nomor shift, kode, nama, dan jam open/close wajib diisi" });
    }

    const payload = [
      shift_number,
      code,
      name,
      open_time,
      close_time,
      flag(body.remind_open, 1),
      flag(body.remind_close, 1),
      flag(body.enforce_open, 0),
      flag(body.enforce_close, 0),
      flag(body.is_active, 1),
      Number(body.sort_order) || shift_number,
      body.notes ? String(body.notes).slice(0, 255) : null,
    ];

    if (id) {
      await safeMyWaschenQuery(
        `UPDATE mst_time_shift SET
          shift_number=?, code=?, name=?, open_time=?, close_time=?,
          remind_open=?, remind_close=?, enforce_open=?, enforce_close=?,
          is_active=?, sort_order=?, notes=?
         WHERE id=?`,
        [...payload, id],
      );
      const [rows] = await safeMyWaschenQuery(`SELECT * FROM mst_time_shift WHERE id=?`, [id]);
      return res.json({ success: true, message: "Jam shift diperbarui", data: normalizeShift(rows[0]) });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_time_shift
        (shift_number, code, name, open_time, close_time,
         remind_open, remind_close, enforce_open, enforce_close,
         is_active, sort_order, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload,
    );
    return res.status(201).json({ success: true, message: "Jam shift ditambahkan", data: { id: result.insertId } });
  } catch (err) {
    console.error("upsertShiftTime:", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "Kode / nomor shift sudah dipakai" });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteShiftTime = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, message: "ID tidak valid" });
    const [exist] = await safeMyWaschenQuery(`SELECT id FROM mst_time_shift WHERE id=?`, [id]);
    if (!exist.length) return res.status(404).json({ success: false, message: "Shift tidak ditemukan" });
    await safeMyWaschenQuery(`DELETE FROM mst_time_shift WHERE id=?`, [id]);
    return res.json({ success: true, message: "Jam shift dihapus" });
  } catch (err) {
    console.error("deleteShiftTime:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
