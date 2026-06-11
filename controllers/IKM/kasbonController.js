import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const BASE_DIR = isProd
  ? process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/"
  : path.join(__dirname, "..", "..", "assets");

const IKM_COMPANY_ID = 2;

// ── Helpers ────────────────────────────────────────────────────────────────
// Cutoff: tgl 26 bulan lalu s/d tgl 25 bulan ini.
// Jika hari ini > 25, aktifkan cutoff bulan depan.
function getDefaultCutoff() {
  const now = new Date();
  const CUTOFF_END_DAY = 25;
  let month = now.getMonth() + 1;
  let year  = now.getFullYear();
  if (now.getDate() > CUTOFF_END_DAY) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  const pad  = (n) => String(n).padStart(2, "0");
  const start = new Date(year, month - 2, 26);
  const end   = new Date(year, month - 1, CUTOFF_END_DAY);
  const fmt   = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { start: fmt(start), end: fmt(end) };
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function buildProofUrl(req, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  const baseUrl = process.env.IKM_PHOTO_KASBON_BASE_URL || `${req.protocol}://${req.get("host")}/assets/kasbon`;
  return `${baseUrl}/${path.basename(filename)}`;
}

function getCurrentUser(req) {
  // Prefer actor sent explicitly from frontend (localStorage user)
  if (req.body?.actor_name) {
    return {
      id: Number(req.body.actor_id) || 0,
      name: req.body.actor_name,
    };
  }
  return {
    id:
      req.session?.user?.employee?.employee_id ||
      req.session?.user?.employeeId ||
      req.session?.employeeId ||
      0,
    name:
      req.session?.user?.employee?.full_name ||
      req.session?.user?.name ||
      "Admin",
  };
}

// ── GET /employee-options ──────────────────────────────────────────────────
export const getEmployeeOptions = async (req, res) => {
  try {
    const [employees] = await safeQuery(
      `SELECT e.employee_id, e.employee_code, e.full_name
       FROM mst_employee e
       WHERE e.is_deleted = 0 AND e.company_id = ?
       ORDER BY e.full_name ASC`,
      [IKM_COMPANY_ID]
    );
    res.json({ data: employees });
  } catch (err) {
    console.error("getEmployeeOptions:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET / - list kasbon/pinjaman ───────────────────────────────────────────
export const getKasbons = async (req, res) => {
  try {
    const { type, status, startDate, endDate, search, page, limit } = req.query;
    const pg = toPositiveInt(page) ?? 1;
    const lm = Math.min(toPositiveInt(limit) ?? 25, 9999);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (type && ["kasbon", "pinjaman"].includes(type)) {
      where.push("k.type = ?");
      params.push(type);
    }
    if (status && ["pengajuan", "proses", "disetujui", "ditolak"].includes(status)) {
      where.push("k.status = ?");
      params.push(status);
    }
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      where.push("k.submission_date >= ?");
      params.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      where.push("k.submission_date <= ?");
      params.push(endDate);
    }
    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(k.employee_name LIKE ? OR k.purpose LIKE ? OR k.notes LIKE ?)");
      params.push(like, like, like);
    }
    if (req.query.employeeId) {
      where.push("k.employee_id = ?");
      params.push(Number(req.query.employeeId));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total FROM tr_kasbon k ${whereSql}`,
      params
    );

    const [rows] = await safeIKMQuery(
      `SELECT k.id, k.employee_id, k.employee_name, k.type, k.submission_date,
              k.amount_requested, k.amount_approved, k.purpose, k.notes,
              k.proof_path, k.status, k.process_note, k.process_by_name, k.process_at,
              k.approved_note, k.approved_by_name, k.approved_at,
              k.rejection_note, k.created_at, k.updated_at
       FROM tr_kasbon k
       ${whereSql}
       ORDER BY k.submission_date DESC, k.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    // Fetch total_paid for pinjaman that are disetujui
    const pinjamanIds = rows
      .filter((r) => r.type === "pinjaman" && r.status === "disetujui")
      .map((r) => r.id);
    const paymentMap = new Map();
    if (pinjamanIds.length) {
      const ph = pinjamanIds.map(() => "?").join(",");
      const [payments] = await safeIKMQuery(
        `SELECT kasbon_id, SUM(amount) AS total_paid
         FROM tr_kasbon_payment WHERE kasbon_id IN (${ph}) GROUP BY kasbon_id`,
        pinjamanIds
      );
      payments.forEach((p) => paymentMap.set(Number(p.kasbon_id), Number(p.total_paid || 0)));
    }

    // Per-employee akumulasi cutoff bulan ini
    // = SUM(amount_approved disetujui di cutoff) - SUM(payments dari entri tsb)
    const cutoff    = getDefaultCutoff();
    const allEmpIds = [...new Set(rows.map((r) => Number(r.employee_id)))];
    const cutoffMap = new Map();

    if (allEmpIds.length) {
      const ph = allEmpIds.map(() => "?").join(",");

      const [approvedInCutoff] = await safeIKMQuery(
        `SELECT employee_id, SUM(amount_approved) AS total_approved
         FROM tr_kasbon
         WHERE status = 'disetujui'
           AND submission_date BETWEEN ? AND ?
           AND employee_id IN (${ph})
         GROUP BY employee_id`,
        [cutoff.start, cutoff.end, ...allEmpIds]
      );

      const [paidInCutoff] = await safeIKMQuery(
        `SELECT k.employee_id, SUM(p.amount) AS total_paid
         FROM tr_kasbon_payment p
         JOIN tr_kasbon k ON k.id = p.kasbon_id
         WHERE k.status = 'disetujui'
           AND k.submission_date BETWEEN ? AND ?
           AND k.employee_id IN (${ph})
         GROUP BY k.employee_id`,
        [cutoff.start, cutoff.end, ...allEmpIds]
      );

      const approvedM = new Map(approvedInCutoff.map((r) => [Number(r.employee_id), Number(r.total_approved || 0)]));
      const paidM     = new Map(paidInCutoff.map((r)    => [Number(r.employee_id), Number(r.total_paid    || 0)]));

      for (const empId of allEmpIds) {
        cutoffMap.set(empId, (approvedM.get(empId) || 0) - (paidM.get(empId) || 0));
      }
    }

    const data = rows.map((r) => ({
      ...r,
      proof_url: buildProofUrl(req, r.proof_path),
      total_paid: r.type === "pinjaman" ? (paymentMap.get(r.id) ?? 0) : null,
      remaining:
        r.type === "pinjaman" && r.amount_approved
          ? Number(r.amount_approved) - (paymentMap.get(r.id) ?? 0)
          : null,
      cutoff_net:    cutoffMap.get(Number(r.employee_id)) ?? 0,
      cutoff_period: cutoff,
    }));

    res.json({
      data,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
    });
  } catch (err) {
    console.error("getKasbons:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /employee-summary ───────────────────────────────────────────────────
export const getEmployeeSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const where = [];
    const params = [];
    if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      where.push("k.submission_date >= ?"); params.push(startDate);
    }
    if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      where.push("k.submission_date <= ?"); params.push(endDate);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [summaryRows] = await safeIKMQuery(
      `SELECT
         k.employee_id,
         k.employee_name,
         COUNT(CASE WHEN k.type = 'kasbon' THEN 1 END) AS kasbon_count,
         COALESCE(SUM(CASE WHEN k.type = 'kasbon' AND k.status = 'disetujui' THEN k.amount_approved ELSE 0 END), 0) AS kasbon_total,
         COUNT(CASE WHEN k.type = 'pinjaman' THEN 1 END) AS pinjaman_count,
         COALESCE(SUM(CASE WHEN k.type = 'pinjaman' AND k.status = 'disetujui' THEN k.amount_approved ELSE 0 END), 0) AS pinjaman_total
       FROM tr_kasbon k
       ${whereSql}
       GROUP BY k.employee_id, k.employee_name
       ORDER BY k.employee_name ASC`,
      params
    );

    const empIds = summaryRows.map((r) => Number(r.employee_id));
    const paidMap = new Map();
    if (empIds.length) {
      const ph = empIds.map(() => "?").join(",");
      const paidWhere = [`k.status = 'disetujui'`, `k.type = 'pinjaman'`, `k.employee_id IN (${ph})`];
      const paidParams = [...empIds];
      if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        paidWhere.push("k.submission_date >= ?"); paidParams.push(startDate);
      }
      if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        paidWhere.push("k.submission_date <= ?"); paidParams.push(endDate);
      }
      const [paidRows] = await safeIKMQuery(
        `SELECT k.employee_id, SUM(p.amount) AS total_paid
         FROM tr_kasbon_payment p
         JOIN tr_kasbon k ON k.id = p.kasbon_id
         WHERE ${paidWhere.join(" AND ")}
         GROUP BY k.employee_id`,
        paidParams
      );
      paidRows.forEach((r) => paidMap.set(Number(r.employee_id), Number(r.total_paid || 0)));
    }

    const data = summaryRows.map((r) => {
      const kasbonTotal   = Number(r.kasbon_total   || 0);
      const pinjamanTotal = Number(r.pinjaman_total || 0);
      const totalPaid     = paidMap.get(Number(r.employee_id)) || 0;
      return {
        employee_id:    Number(r.employee_id),
        employee_name:  r.employee_name,
        kasbon_count:   Number(r.kasbon_count   || 0),
        kasbon_total:   kasbonTotal,
        pinjaman_count: Number(r.pinjaman_count || 0),
        pinjaman_total: pinjamanTotal,
        total_all:      kasbonTotal + pinjamanTotal,
        total_paid:     totalPaid,
        sisa:           Math.max(0, pinjamanTotal - totalPaid),
      };
    });

    res.json({ data });
  } catch (err) {
    console.error("getEmployeeSummary:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET /:id - single detail + payment history ─────────────────────────────
export const getKasbonDetail = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "ID tidak valid" });

    const [[kasbon]] = await safeIKMQuery(
      `SELECT * FROM tr_kasbon WHERE id = ?`,
      [id]
    );
    if (!kasbon) return res.status(404).json({ message: "Data tidak ditemukan" });

    const [payments] = await safeIKMQuery(
      `SELECT id, payment_date, amount, payment_method, notes, recorded_by_name, created_at
       FROM tr_kasbon_payment WHERE kasbon_id = ? ORDER BY payment_date ASC, id ASC`,
      [id]
    );

    const totalPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);
    const remaining =
      kasbon.type === "pinjaman" && kasbon.amount_approved
        ? Number(kasbon.amount_approved) - totalPaid
        : null;

    res.json({
      data: {
        ...kasbon,
        proof_url: buildProofUrl(req, kasbon.proof_path),
        payments,
        total_paid: totalPaid,
        remaining,
      },
    });
  } catch (err) {
    console.error("getKasbonDetail:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST / - create ────────────────────────────────────────────────────────
export const createKasbon = async (req, res) => {
  try {
    const { employee_id, employee_name, type, submission_date, amount_requested, purpose, notes } =
      req.body;

    if (!employee_id || !employee_name || !type || !submission_date || !amount_requested || !purpose) {
      return res.status(400).json({ message: "Field wajib tidak lengkap" });
    }
    if (!["kasbon", "pinjaman"].includes(type)) {
      return res.status(400).json({ message: "Tipe tidak valid" });
    }

    const proof_path = req.file?.filename || null;

    const [result] = await safeIKMQuery(
      `INSERT INTO tr_kasbon
         (employee_id, employee_name, type, submission_date, amount_requested, purpose, notes, proof_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pengajuan')`,
      [
        Number(employee_id),
        employee_name,
        type,
        submission_date,
        Number(amount_requested),
        purpose,
        notes || null,
        proof_path,
      ]
    );

    res.status(201).json({ message: "Pengajuan berhasil dibuat", id: result.insertId });
  } catch (err) {
    console.error("createKasbon:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /:id - update basic info ───────────────────────────────────────────
export const updateKasbon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { employee_id, employee_name, type, submission_date, amount_requested, purpose, notes, remove_proof } =
      req.body;

    const [[existing]] = await safeIKMQuery(`SELECT * FROM tr_kasbon WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

    let proof_path = existing.proof_path;

    if (req.file) {
      // Delete old file
      if (existing.proof_path) {
        const oldPath = path.join(BASE_DIR, "kasbon", existing.proof_path);
        fs.unlink(oldPath, () => {});
      }
      proof_path = req.file.filename;
    } else if (remove_proof === "true" || remove_proof === true) {
      if (existing.proof_path) {
        const oldPath = path.join(BASE_DIR, "kasbon", existing.proof_path);
        fs.unlink(oldPath, () => {});
      }
      proof_path = null;
    }

    await safeIKMQuery(
      `UPDATE tr_kasbon
       SET employee_id=?, employee_name=?, type=?, submission_date=?,
           amount_requested=?, purpose=?, notes=?, proof_path=?
       WHERE id=?`,
      [
        Number(employee_id || existing.employee_id),
        employee_name || existing.employee_name,
        type || existing.type,
        submission_date || existing.submission_date,
        Number(amount_requested || existing.amount_requested),
        purpose || existing.purpose,
        notes !== undefined ? notes || null : existing.notes,
        proof_path,
        id,
      ]
    );

    res.json({ message: "Data berhasil diperbarui" });
  } catch (err) {
    console.error("updateKasbon:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT /:id/status - change status ───────────────────────────────────────
export const updateKasbonStatus = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, process_note, approved_note, rejection_note, amount_approved } = req.body;
    const admin = getCurrentUser(req);

    if (!["proses", "disetujui", "ditolak"].includes(status)) {
      return res.status(400).json({ message: "Status tidak valid" });
    }

    const [[existing]] = await safeIKMQuery(`SELECT * FROM tr_kasbon WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");

    if (status === "proses") {
      await safeIKMQuery(
        `UPDATE tr_kasbon
         SET status='proses', process_note=?, process_by=?, process_by_name=?, process_at=?
         WHERE id=?`,
        [process_note || null, admin.id, admin.name, now, id]
      );
    } else if (status === "disetujui") {
      if (!amount_approved) {
        return res.status(400).json({ message: "Jumlah yang disetujui wajib diisi" });
      }
      await safeIKMQuery(
        `UPDATE tr_kasbon
         SET status='disetujui', amount_approved=?, approved_note=?,
             approved_by=?, approved_by_name=?, approved_at=?
         WHERE id=?`,
        [Number(amount_approved), approved_note || null, admin.id, admin.name, now, id]
      );
    } else if (status === "ditolak") {
      await safeIKMQuery(
        `UPDATE tr_kasbon SET status='ditolak', rejection_note=? WHERE id=?`,
        [rejection_note || null, id]
      );
    }

    res.json({ message: `Status berhasil diubah ke ${status}` });
  } catch (err) {
    console.error("updateKasbonStatus:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /:id ────────────────────────────────────────────────────────────
export const deleteKasbon = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[existing]] = await safeIKMQuery(`SELECT * FROM tr_kasbon WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

    if (existing.proof_path) {
      const filePath = path.join(BASE_DIR, "kasbon", existing.proof_path);
      fs.unlink(filePath, () => {});
    }

    await safeIKMQuery(`DELETE FROM tr_kasbon WHERE id = ?`, [id]);
    res.json({ message: "Data berhasil dihapus" });
  } catch (err) {
    console.error("deleteKasbon:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST /:id/payment - add payment record ─────────────────────────────────
export const addPayment = async (req, res) => {
  try {
    const kasbon_id = Number(req.params.id);
    const { payment_date, amount, payment_method, notes } = req.body;
    const admin = getCurrentUser(req);

    if (!payment_date || !amount || !payment_method) {
      return res.status(400).json({ message: "Field wajib tidak lengkap" });
    }
    if (!["tunai", "potong_gaji", "transfer"].includes(payment_method)) {
      return res.status(400).json({ message: "Metode pembayaran tidak valid" });
    }

    const [[kasbon]] = await safeIKMQuery(`SELECT * FROM tr_kasbon WHERE id = ?`, [kasbon_id]);
    if (!kasbon) return res.status(404).json({ message: "Data kasbon tidak ditemukan" });
    if (kasbon.type !== "pinjaman") {
      return res.status(400).json({ message: "Pembayaran hanya untuk tipe pinjaman" });
    }
    if (kasbon.status !== "disetujui") {
      return res.status(400).json({ message: "Pinjaman belum disetujui" });
    }

    await safeIKMQuery(
      `INSERT INTO tr_kasbon_payment
         (kasbon_id, payment_date, amount, payment_method, notes, recorded_by, recorded_by_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [kasbon_id, payment_date, Number(amount), payment_method, notes || null, admin.id, admin.name]
    );

    res.status(201).json({ message: "Pembayaran berhasil dicatat" });
  } catch (err) {
    console.error("addPayment:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /:id/payment/:paymentId ─────────────────────────────────────────
export const deletePayment = async (req, res) => {
  try {
    const kasbon_id = Number(req.params.id);
    const payment_id = Number(req.params.paymentId);

    const [[payment]] = await safeIKMQuery(
      `SELECT id FROM tr_kasbon_payment WHERE id = ? AND kasbon_id = ?`,
      [payment_id, kasbon_id]
    );
    if (!payment) return res.status(404).json({ message: "Data pembayaran tidak ditemukan" });

    await safeIKMQuery(`DELETE FROM tr_kasbon_payment WHERE id = ?`, [payment_id]);
    res.json({ message: "Pembayaran berhasil dihapus" });
  } catch (err) {
    console.error("deletePayment:", err);
    res.status(500).json({ message: err.message });
  }
};
