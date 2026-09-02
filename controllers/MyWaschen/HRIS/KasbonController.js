import { safeMyWaschenQuery } from "../../../db/pool.js";

import { defaultCutoffDateRange } from "../cutoffHelpers.js";

import { getActor, toISODate, resolveMstRoleEmployeeIds, appendEmployeeIdInClause } from "./hrisHelpers.js";

import { buildKasbonProofUrl } from "./hrisAssetHelpers.js";



export const getKasbonList = async (req, res) => {

  try {

    const defaults = defaultCutoffDateRange();

    const startDate = toISODate(req.query.startDate) || defaults.dateFrom;

    const endDate = toISODate(req.query.endDate) || defaults.dateTo;

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

              COALESCE((SELECT SUM(p.amount) FROM tr_kasbon_payment p WHERE p.kasbon_id = k.id), 0) AS total_paid

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



    return res.json({ success: true, data: items, summary });

  } catch (err) {

    console.error("getKasbonList:", err);

    return res.status(500).json({ success: false, message: err.message || "Gagal memuat kasbon" });

  }

};



export const getKasbonById = async (req, res) => {

  try {

    const id = Number(req.params.id);

    const [rows] = await safeMyWaschenQuery("SELECT * FROM tr_kasbon WHERE id = ? LIMIT 1", [id]);

    if (!rows.length) return res.status(404).json({ success: false, message: "Data tidak ditemukan" });

    const [payments] = await safeMyWaschenQuery(

      `SELECT * FROM tr_kasbon_payment WHERE kasbon_id = ? ORDER BY payment_date ASC`,

      [id],

    );

    const totalPaid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const approved = Number(rows[0].amount_approved ?? rows[0].amount_requested) || 0;

    return res.json({

      success: true,

      data: {

        ...rows[0],

        submission_date: toISODate(rows[0].submission_date),

        proof_url: buildKasbonProofUrl(req, rows[0].proof_path),

        payments,

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

    return res.json({ success: true, message: "Pengajuan diproses" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const approveKasbon = async (req, res) => {

  try {

    const actor = getActor(req);

    const id = Number(req.params.id);

    const amount = req.body.amount_approved != null ? Number(req.body.amount_approved) : null;

    const note = String(req.body.approved_note || req.body.note || "").trim();

    if (amount != null) {

      await safeMyWaschenQuery(

        `UPDATE tr_kasbon SET status = 'disetujui', amount_approved = ?, approved_note = ?, approved_by_name = ?, approved_at = NOW() WHERE id = ?`,

        [amount, note || null, actor.name, id],

      );

    } else {

      await safeMyWaschenQuery(

        `UPDATE tr_kasbon SET status = 'disetujui', amount_approved = amount_requested, approved_note = ?, approved_by_name = ?, approved_at = NOW() WHERE id = ?`,

        [note || null, actor.name, id],

      );

    }

    return res.json({ success: true, message: "Kasbon disetujui" });

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

    return res.json({ success: true, message: "Kasbon ditolak" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};



export const addKasbonPayment = async (req, res) => {

  try {

    const actor = getActor(req);

    const id = Number(req.params.id);

    const { payment_date, amount, payment_method, notes } = req.body;

    if (!payment_date || !amount) {

      return res.status(422).json({ success: false, message: "Tanggal dan jumlah pembayaran wajib" });

    }

    await safeMyWaschenQuery(

      `INSERT INTO tr_kasbon_payment (kasbon_id, payment_date, amount, payment_method, notes, recorded_by_name)

       VALUES (?, ?, ?, ?, ?, ?)`,

      [id, payment_date, Number(amount), payment_method || null, notes || null, actor.name],

    );

    return res.json({ success: true, message: "Pembayaran tercatat" });

  } catch (err) {

    return res.status(500).json({ success: false, message: err.message });

  }

};


