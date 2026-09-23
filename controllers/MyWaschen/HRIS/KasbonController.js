import { safeQuery, safeMyWaschenQuery, myWaschenPool } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getActor, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause } from "./hrisHelpers.js";

import { buildKasbonProofUrl } from "./hrisAssetHelpers.js";

import { notifyWaschenRealtime } from "../../../utils/notifyWaschenRealtime.js";

import { uploadKasbonPaymentProof, deleteWaschenMobileUpload } from "../../../utils/waschenMobileUpload.js";
import { buildKasbonSummary, getEmployeeSalary, insertSchedule, splitInstallments } from "./kasbonLimit.js";



export const getKasbonList = async (req, res) => {

  try {

    const defaults = defaultCutoffDateRange();

    const allPeriods = req.query.all === "1";

    const startDate = allPeriods ? "" : (toISODate(req.query.startDate) || defaults.dateFrom);

    const endDate = allPeriods ? "" : (toISODate(req.query.endDate) || defaults.dateTo);

    const [yearRows] = await safeMyWaschenQuery(
      `SELECT DISTINCT YEAR(submission_date) AS year
       FROM tr_kasbon
       WHERE submission_date IS NOT NULL
       ORDER BY year DESC`,
    );
    const years = yearRows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y) && y > 0);

    const status = req.query.status ? String(req.query.status) : "";

    const type = req.query.type ? String(req.query.type) : "";

    const employeeId = req.query.employeeId ? Number(req.query.employeeId) : null;

    const outletId = req.query.outletId ? Number(req.query.outletId) : null;

    const role = req.query.role ? String(req.query.role).trim() : "";

    const search = String(req.query.search || "").trim().toLowerCase();



    const roleEmployeeIds = await resolveMstRoleEmployeeIds(outletId, role);

    if (roleEmployeeIds && roleEmployeeIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        summary: { total: 0, pengajuan: 0, proses: 0, disetujui: 0, ditolak: 0 },
        years,
      });
    }

    const cond = ["1=1"];

    const params = [];

    if (startDate) {

      cond.push("k.submission_date >= ?");

      params.push(startDate);

    }

    if (endDate) {

      cond.push("k.submission_date <= ?");

      params.push(endDate);

    }

    if (status && status !== "Semua") {

      cond.push("k.status = ?");

      params.push(status.toLowerCase());

    }

    if (type && type !== "Semua") {

      cond.push("k.type = ?");

      params.push(type.toLowerCase());

    }

    if (employeeId) {

      cond.push("k.employee_id = ?");

      params.push(employeeId);

    }

    appendEmployeeIdInClause(cond, params, roleEmployeeIds, "k.employee_id");



    const [rows] = await safeMyWaschenQuery(

      `SELECT k.*,

              COALESCE((SELECT SUM(p.amount) FROM tr_kasbon_payment p WHERE p.kasbon_id = k.id AND p.status = 'terbayar'), 0) AS total_paid

       FROM tr_kasbon k

       WHERE ${cond.join(" AND ")}

       ORDER BY k.submission_date DESC, k.created_at DESC

       LIMIT 1000`,

      params,

    );



    let items = rows.map((r) => {

      const totalPaid = Number(r.total_paid) || 0;

      const approved = Number(r.amount_approved ?? r.amount_requested) || 0;

      const remaining = r.status === "disetujui" && r.type === "pinjaman"

        ? Math.max(0, approved - totalPaid)

        : 0;

      return {

        ...r,

        submission_date: toISODate(r.submission_date),

        proof_url: buildKasbonProofUrl(req, r.proof_path),

        total_paid: totalPaid,

        remaining,

      };

    });



    if (search) {

      items = items.filter(

        (r) =>

          r.employee_name?.toLowerCase().includes(search) ||

          r.purpose?.toLowerCase().includes(search) ||

          r.type?.includes(search),

      );

    }



    const summary = {

      total: items.length,

      pengajuan: items.filter((r) => r.status === "pengajuan").length,

      proses: items.filter((r) => r.status === "proses").length,

      disetujui: items.filter((r) => r.status === "disetujui").length,

      ditolak: items.filter((r) => r.status === "ditolak").length,

    };



    return res.json({ success: true, data: items, summary, years });

  } catch (err) {

    console.error("getKasbonList:", err);

    return res.status(500).json({ success: false, message: err.message || "Gagal memuat kasbon" });

  }

};



export const getKasbonMonitor = async (req, res) => {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;
    const role = req.query.role ? String(req.query.role).trim() : "";
    const search = String(req.query.search || "").trim().toLowerCase();
    const roleEmployeeIds = await resolveMstRoleEmployeeIds(outletId, role);
    if (roleEmployeeIds && roleEmployeeIds.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const cond = ["e.company_id = 5", "e.is_deleted = 0", "e.exit_date IS NULL"];
    const params = [];
    if (roleEmployeeIds) {
      cond.push(`e.employee_id IN (${roleEmployeeIds.map(() => "?").join(",")})`);
      params.push(...roleEmployeeIds);
    }
    const [employees] = await safeQuery(
      `SELECT e.employee_id, e.full_name, e.employee_code, e.take_home_pay
       FROM mst_employee e
       WHERE ${cond.join(" AND ")}
       ORDER BY e.full_name ASC`,
      params,
    );

    const [pending] = await safeMyWaschenQuery(
      `SELECT employee_id, COALESCE(SUM(amount_requested), 0) AS hold
       FROM tr_kasbon
       WHERE status IN ('pengajuan','proses')
       GROUP BY employee_id`,
    );
    const [openPay] = await safeMyWaschenQuery(
      `SELECT k.employee_id, COALESCE(SUM(p.amount), 0) AS hold
       FROM tr_kasbon_payment p
       JOIN tr_kasbon k ON k.id = p.kasbon_id
       WHERE k.status = 'disetujui' AND p.status = 'belum'
       GROUP BY k.employee_id`,
    );
    const [legacy] = await safeMyWaschenQuery(
      `SELECT k.employee_id, COALESCE(SUM(COALESCE(k.amount_approved, k.amount_requested)), 0) AS hold
       FROM tr_kasbon k
       WHERE k.status = 'disetujui'
         AND NOT EXISTS (SELECT 1 FROM tr_kasbon_payment p WHERE p.kasbon_id = k.id)
       GROUP BY k.employee_id`,
    );

    const hold = new Map();
    for (const bucket of [pending, openPay, legacy]) {
      for (const row of bucket) {
        const id = Number(row.employee_id);
        hold.set(id, (hold.get(id) || 0) + (Number(row.hold) || 0));
      }
    }

    let data = employees.map((emp) => {
      const salary = Number(emp.take_home_pay) || 0;
      const limit = Math.floor(salary / 2);
      const pinjaman = hold.get(Number(emp.employee_id)) || 0;
      return {
        employee_id: emp.employee_id,
        employee_name: emp.full_name,
        employee_code: emp.employee_code,
        limit,
        pinjaman,
        sisa: Math.max(0, limit - pinjaman),
        has_salary: salary > 0,
      };
    });
    if (search) {
      data = data.filter((row) =>
        String(row.employee_name || "").toLowerCase().includes(search)
        || String(row.employee_code || "").toLowerCase().includes(search),
      );
    }
    data.sort((a, b) => b.pinjaman - a.pinjaman || String(a.employee_name || "").localeCompare(String(b.employee_name || ""), "id"));
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getKasbonMonitor:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat pantauan kasbon" });
  }
};

export const getKasbonMonitorDetail = async (req, res) => {
  try {
    const employeeId = Number(req.params.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ success: false, message: "Karyawan tidak valid" });
    }
    // exclude=<kasbonId>: sisa tanpa hold pengajuan itu sendiri (dipakai modal setujui/tolak)
    const excludeId = Number(req.query.exclude) || null;
    const summary = await buildKasbonSummary(employeeId, excludeId);
    const [rows] = await safeMyWaschenQuery(
      `SELECT id, type, status, amount_requested, amount_approved, tenor_count, purpose,
              submission_date, payment_method, is_opening_balance, approved_note, rejection_note
       FROM tr_kasbon
       WHERE employee_id = ?
       ORDER BY submission_date DESC, id DESC`,
      [employeeId],
    );
    const ids = rows.map((row) => row.id);
    const payMap = new Map();
    if (ids.length) {
      const [pays] = await safeMyWaschenQuery(
        `SELECT id, kasbon_id, installment_no, due_date, amount, status, paid_at, proof_path
         FROM tr_kasbon_payment
         WHERE kasbon_id IN (${ids.map(() => "?").join(",")})
         ORDER BY installment_no ASC, id ASC`,
        ids,
      );
      for (const pay of pays) {
        const list = payMap.get(pay.kasbon_id) || [];
        list.push({
          id: pay.id,
          installment_no: pay.installment_no,
          due_date: toISODate(pay.due_date),
          amount: Number(pay.amount) || 0,
          status: pay.status,
          paid_at: pay.paid_at ? toISODate(pay.paid_at) : null,
          proof_url: buildKasbonProofUrl(req, pay.proof_path),
        });
        payMap.set(pay.kasbon_id, list);
      }
    }
    return res.json({
      success: true,
      data: {
        employee_id: employeeId,
        employee_name: summary.employeeName,
        limit: summary.limit,
        pinjaman: summary.reserved,
        sisa: summary.sisa,
        has_salary: summary.hasSalary,
        history: rows.map((row) => ({
          id: row.id,
          type: row.type,
          status: row.status,
          amount_requested: Number(row.amount_requested) || 0,
          amount_approved: row.amount_approved == null ? null : Number(row.amount_approved),
          tenor_count: row.tenor_count,
          purpose: row.purpose,
          submission_date: toISODate(row.submission_date),
          payment_method: row.payment_method,
          is_opening_balance: Number(row.is_opening_balance) === 1,
          rejection_note: row.rejection_note,
          payments: payMap.get(row.id) || [],
        })),
      },
    });
  } catch (err) {
    console.error("getKasbonMonitorDetail:", err);
    return res.status(500).json({ success: false, message: err.message || "Gagal memuat riwayat kasbon" });
  }
};

export const getKasbonById = async (req, res) => {

  try {

    const id = Number(req.params.id);

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_kasbon WHERE id = ? LIMIT 1", [id]);

    if (!rows.length) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });

    const [payments] = await safeMyWaschenQuery(

      `SELECT * FROM tr_kasbon_payment WHERE kasbon_id = ? ORDER BY installment_no ASC, payment_date ASC`,

      [id],

    );

    const totalPaid = payments
      .filter((p) => p.status === "terbayar")
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const approved = Number(rows[0].amount_approved ?? rows[0].amount_requested) || 0;

    return res.json({

      success: true,

      data: {

        ...rows[0],

        submission_date: toISODate(rows[0].submission_date),

        proof_url: buildKasbonProofUrl(req, rows[0].proof_path),

        payments: payments.map((p) => ({
          ...p,
          due_date: toISODate(p.due_date),
          payment_date: toISODate(p.payment_date),
          proof_url: buildKasbonProofUrl(req, p.proof_path),
        })),

        total_paid: totalPaid,

        remaining: rows[0].status === "disetujui" && rows[0].type === "pinjaman"

          ? Math.max(0, approved - totalPaid)

          : 0,

      },

    });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const processKasbon = async (req, res) => {

  try {

    const actor = getActor(req);

    const id = Number(req.params.id);

    const note = String(req.body.process_note || req.body.note || "").trim();

    await safeMyWaschenQuery(

      `UPDATE tr_kasbon SET status = 'proses', process_note = ?, process_by_name = ?, process_at = NOW() WHERE id = ? AND status = 'pengajuan'`,

      [note || null, actor.name, id],

    );

    const [row] = await safeMyWaschenQuery(`SELECT employee_id FROM tr_kasbon WHERE id = ? LIMIT 1`, [id]);
    await notifyWaschenRealtime({ domain: "kasbon", employeeId: row?.[0]?.employee_id, action: "process" });

    return res.json({ success: true, message: "Pengajuan diproses" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const approveKasbon = async (req, res) => {

  try {

    const actor = getActor(req);

    const id = Number(req.params.id);

    const note = String(req.body.approved_note || req.body.note || "").trim();

    const paymentMethod = String(req.body.payment_method || "").trim();

    if (paymentMethod !== "potong_gaji" && paymentMethod !== "langsung") {

      return res.status(422).json({ success: false, message: "Metode bayar wajib dipilih: potong gaji atau bayar langsung" });

    }

    const [rows] = await safeMyWaschenQuery(

      `SELECT id, employee_id, type, status, amount_requested, tenor_count FROM tr_kasbon WHERE id = ? LIMIT 1`,

      [id],

    );

    const row = rows[0];

    if (!row) return res.status(404).json({ success: false, message: "Pengajuan tidak ditemukan" });

    if (row.status !== "pengajuan" && row.status !== "proses") {

      return res.status(422).json({ success: false, message: "Pengajuan ini sudah tidak bisa disetujui" });

    }

    const requested = Number(row.amount_requested) || 0;

    const approved = req.body.amount_approved != null && req.body.amount_approved !== ""

      ? Number(req.body.amount_approved)

      : requested;

    if (!approved || approved <= 0 || approved > requested) {

      return res.status(422).json({ success: false, message: "Nominal disetujui harus lebih dari 0 dan tidak melebihi pengajuan" });

    }

    const summary = await buildKasbonSummary(row.employee_id, id);

    if (!summary.hasSalary) {

      return res.status(422).json({ success: false, message: "Take Home Pay karyawan belum diisi. Lengkapi dulu di Master Karyawan." });

    }

    if (approved > summary.sisa) {

      return res.status(422).json({ success: false, message: `Nominal melebihi sisa limit (Rp ${summary.sisa.toLocaleString("id-ID")}).` });

    }

    const tenor = row.type === "kasbon" ? 1 : Math.max(1, Number(row.tenor_count) || 1);

    const amounts = splitInstallments(approved, tenor);

    const conn = await myWaschenPool.getConnection();

    try {

      await conn.beginTransaction();

      const q = (sql, params) => conn.query(sql, params);

      const [updated] = await q(

        `UPDATE tr_kasbon

         SET status = 'disetujui', amount_approved = ?, payment_method = ?, tenor_count = ?, installment_amount = ?,

             approved_note = ?, approved_by_name = ?, approved_at = NOW()

         WHERE id = ? AND status IN ('pengajuan','proses')`,

        [approved, paymentMethod, tenor, amounts[0], note || null, actor.name, id],

      );

      if (!updated.affectedRows) {

        await conn.rollback();

        return res.status(422).json({ success: false, message: "Pengajuan ini sudah tidak bisa disetujui" });

      }

      await insertSchedule({

        kasbonId: id,

        amounts,

        currentIndex: 0,

        paymentMethod,

        actorName: actor.name,

      }, q);

      await conn.commit();

    } catch (err) {

      await conn.rollback();

      throw err;

    } finally {

      conn.release();

    }

    await notifyWaschenRealtime({ domain: "kasbon", employeeId: row.employee_id, action: "approve" });

    return res.json({ success: true, message: "Kasbon disetujui dan jadwal termin dibuat" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const rejectKasbon = async (req, res) => {

  try {

    const id = Number(req.params.id);

    const note = String(req.body.rejection_note || req.body.note || "").trim();

    await safeMyWaschenQuery(

      `UPDATE tr_kasbon SET status = 'ditolak', rejection_note = ? WHERE id = ?`,

      [note || "Ditolak admin", id],

    );

    const [row] = await safeMyWaschenQuery(`SELECT employee_id FROM tr_kasbon WHERE id = ? LIMIT 1`, [id]);
    await notifyWaschenRealtime({ domain: "kasbon", employeeId: row?.[0]?.employee_id, action: "reject" });

    return res.json({ success: true, message: "Kasbon ditolak" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const addKasbonPayment = async (_req, res) => {

  return res.status(422).json({

    success: false,

    message: "Pembayaran dicatat lewat termin. Gunakan tandai lunas pada jadwal cicilan.",

  });

};



export const markKasbonInstallmentPaid = async (req, res) => {
  const actor = getActor(req);
  const kasbonId = Number(req.params.id);
  const paymentId = Number(req.params.paymentId);
  const paid = Math.round(Number(req.body.amount));
  if (!req.file) {
    return res.status(422).json({ success: false, message: "Bukti pembayaran wajib dilampirkan" });
  }
  if (!paid || paid <= 0) {
    return res.status(422).json({ success: false, message: "Nominal bayar harus lebih dari 0" });
  }

  let proofPath;
  try {
    proofPath = await uploadKasbonPaymentProof(req.file);
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message });
  }
  const dropFile = () => deleteWaschenMobileUpload("kasbon", proofPath);

  const conn = await myWaschenPool.getConnection();
  try {
    await conn.beginTransaction();
    const q = (sql, params) => conn.query(sql, params);
    const [rows] = await q(
      `SELECT p.amount, p.installment_no, p.payment_date, p.due_date, p.payment_method, k.employee_id, k.type
       FROM tr_kasbon_payment p
       JOIN tr_kasbon k ON k.id = p.kasbon_id
       WHERE p.id = ? AND p.kasbon_id = ? AND k.status = 'disetujui' AND p.status = 'belum'
       LIMIT 1
       FOR UPDATE`,
      [paymentId, kasbonId],
    );
    const row = rows[0];
    if (!row) {
      await conn.rollback();
      dropFile();
      return res.status(422).json({ success: false, message: "Jadwal tidak ditemukan atau sudah lunas" });
    }
    const scheduled = Math.round(Number(row.amount) || 0);
    if (paid > scheduled) {
      await conn.rollback();
      dropFile();
      return res.status(422).json({ success: false, message: "Nominal bayar tidak boleh melebihi sisa jadwal ini" });
    }
    const [updated] = await q(
      `UPDATE tr_kasbon_payment
       SET amount = ?, status = 'terbayar', paid_at = NOW(), recorded_by_name = ?, proof_path = ?
       WHERE id = ? AND status = 'belum'`,
      [paid, actor.name, proofPath, paymentId],
    );
    if (!updated.affectedRows) {
      await conn.rollback();
      dropFile();
      return res.status(422).json({ success: false, message: "Jadwal tidak ditemukan atau sudah lunas" });
    }
    if (paid < scheduled) {
      await q(
        `INSERT INTO tr_kasbon_payment
          (kasbon_id, installment_no, payment_date, due_date, amount, payment_method, status, notes)
         VALUES (?, ?, ?, ?, ?, ?, 'belum', ?)`,
        [
          kasbonId,
          row.installment_no,
          row.payment_date,
          row.due_date,
          scheduled - paid,
          row.payment_method,
          "Sisa belum terbayar",
        ],
      );
    }
    await conn.commit();
    await notifyWaschenRealtime({ domain: "kasbon", employeeId: row.employee_id, action: "paid" });
    return res.json({ success: true, message: paid < scheduled ? "Sebagian pembayaran dicatat. Sisanya tetap belum lunas." : "Pembayaran dicatat lunas" });
  } catch (err) {
    await conn.rollback();
    dropFile();
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    conn.release();
  }
};



export const createOpeningBalance = async (req, res) => {

  try {

    const actor = getActor(req);

    const employeeId = Number(req.body.employee_id);

    const type = String(req.body.type || "");

    const amount = Number(req.body.amount);

    const paymentMethod = String(req.body.payment_method || "").trim();

    const purpose = String(req.body.purpose || "Saldo awal sebelum sistem").trim();

    if (!employeeId || (type !== "kasbon" && type !== "pinjaman")) {

      return res.status(422).json({ success: false, message: "Karyawan dan jenis saldo awal wajib diisi" });

    }

    if (paymentMethod !== "potong_gaji" && paymentMethod !== "langsung") {

      return res.status(422).json({ success: false, message: "Metode bayar wajib dipilih" });

    }

    if (!amount || amount <= 0) {

      return res.status(422).json({ success: false, message: "Sisa pokok harus lebih dari 0" });

    }

    const tenor = type === "kasbon" ? 1 : parseInt(req.body.tenor_count, 10);

    const currentNo = type === "kasbon" ? 1 : parseInt(req.body.current_installment_no, 10);

    if (!Number.isInteger(tenor) || tenor < 1 || tenor > 36) {

      return res.status(422).json({ success: false, message: "Jumlah termin pinjaman harus 1 sampai 36" });

    }

    if (!Number.isInteger(currentNo) || currentNo < 1 || currentNo > tenor) {

      return res.status(422).json({ success: false, message: "Termin yang jatuh tempo sekarang harus di antara 1 dan jumlah termin" });

    }

    const emp = await getEmployeeSalary(employeeId);

    if (!emp) return res.status(404).json({ success: false, message: "Karyawan tidak ditemukan" });

    const summary = await buildKasbonSummary(employeeId);

    if (!summary.hasSalary) {

      return res.status(422).json({ success: false, message: "Take Home Pay karyawan belum diisi. Lengkapi dulu di Master Karyawan." });

    }

    if (amount > summary.sisa) {

      return res.status(422).json({ success: false, message: `Sisa pokok melebihi sisa limit (Rp ${summary.sisa.toLocaleString("id-ID")}).` });

    }

    const amounts = splitInstallments(amount, tenor);

    const today = summary.cutoffEnd;

    const conn = await myWaschenPool.getConnection();

    let openingId;

    try {

      await conn.beginTransaction();

      const q = (sql, params) => conn.query(sql, params);

      const [result] = await q(

        `INSERT INTO tr_kasbon

          (employee_id, employee_name, type, submission_date, amount_requested, amount_approved,

           payment_method, tenor_count, installment_amount, is_opening_balance, purpose, status,

           approved_by_name, approved_at, approved_note)

         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'disetujui', ?, NOW(), ?)`,

        [

          employeeId,

          emp.full_name || "Karyawan",

          type,

          today,

          amount,

          amount,

          paymentMethod,

          tenor,

          amounts[0],

          purpose.slice(0, 500),

          actor.name,

          "Saldo awal",

        ],

      );

      openingId = result.insertId;

      await insertSchedule({

        kasbonId: openingId,

        amounts,

        currentIndex: currentNo - 1,

        paymentMethod,

        actorName: actor.name,

      }, q);

      await conn.commit();

    } catch (err) {

      await conn.rollback();

      throw err;

    } finally {

      conn.release();

    }

    await notifyWaschenRealtime({ domain: "kasbon", employeeId, action: "opening" });

    return res.status(201).json({ success: true, message: "Saldo awal tersimpan", id: openingId });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};


