import fs from "fs";
import path from "path";
import { safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_PAYMENT_PROOF_DIR } from "../../middleware/upload.js";
import {
	buildOmzetDateExpr,
	buildPosOmzetDateExpr,
	isNonTunaiSummaryKategori,
	isTunaiKategori,
	mapKategori,
	mapKategoriUnified,
} from "./cleanoxOmzetUnified.js";

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "").trim())
		? String(value).trim()
		: null;
}

function toDateOnly(value) {
	if (!value) return null;
	if (value instanceof Date) {
		const y = value.getFullYear();
		const m = String(value.getMonth() + 1).padStart(2, "0");
		const d = String(value.getDate()).padStart(2, "0");
		return `${y}-${m}-${d}`;
	}
	return String(value).slice(0, 10);
}

function buildPaymentProofUrl(photoFile) {
	if (!photoFile) return null;
	return `/cleanox/riwayat-transaksi/payment-proofs/${encodeURIComponent(path.basename(String(photoFile)))}`;
}

function normalizeServiceMode(raw) {
	const mode = String(raw || "all").trim().toLowerCase();
	if (mode === "home_service" || mode === "take_home") return mode;
	return "all";
}

function normalizeDateBy(raw) {
	const v = String(raw || "").trim().toLowerCase();
	if (v === "settled") return "settled";
	if (v === "omzet") return "omzet";
	return "service";
}

function normalizeSource(raw) {
	return String(raw || "").trim().toLowerCase() === "unified" ? "unified" : "pos";
}

export { mapKategori };

/**
 * GET /cleanox/riwayat-transaksi
 * source=pos (default) | unified
 * date_by=service (default) | settled | omzet
 */
export async function listRiwayatTransaksi(req, res) {
	try {
		const startDate = toISODateString(req.query.startDate);
		const endDate = toISODateString(req.query.endDate);
		const search = String(req.query.search || "").trim();
		const status = String(req.query.status || "").trim();
		const paymentStatus = String(req.query.payment_status || "").trim();
		const dateBy = normalizeDateBy(req.query.date_by);
		const source = normalizeSource(req.query.source);
		const serviceMode = normalizeServiceMode(req.query.service_mode);
		const splitPayment = String(req.query.split_payment || "").trim() === "1";

		if (!startDate || !endDate) {
			return res.status(400).json({
				message: "startDate dan endDate wajib (YYYY-MM-DD)",
			});
		}
		if (endDate < startDate) {
			return res.status(400).json({
				message: "Tanggal akhir tidak boleh lebih kecil dari tanggal mulai",
			});
		}

		if (source === "unified") {
			return await listUnifiedRiwayat({
				res,
				startDate,
				endDate,
				search,
				status,
				paymentStatus,
				dateBy,
				serviceMode,
				splitPayment,
			});
		}

		return await listPosRiwayat({
			res,
			startDate,
			endDate,
			search,
			status,
			paymentStatus,
			dateBy,
			serviceMode,
		});
	} catch (err) {
		console.error("[listRiwayatTransaksi Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memuat riwayat transaksi POS" });
	}
}

async function listPosRiwayat({
	res,
	startDate,
	endDate,
	search,
	status,
	paymentStatus,
	dateBy,
	serviceMode,
}) {
	const omzetExpr = buildPosOmzetDateExpr("t");
	let dateFilterSql;
	let orderBySql;
	if (dateBy === "settled") {
		dateFilterSql = `t.payment_settled_date IS NOT NULL
        AND t.payment_settled_date >= ?
        AND t.payment_settled_date <= ?`;
		orderBySql = ` ORDER BY t.payment_settled_date ASC, t.transaction_no ASC`;
	} else if (dateBy === "omzet") {
		dateFilterSql = `(${omzetExpr}) >= ?
        AND (${omzetExpr}) <= ?`;
		orderBySql = ` ORDER BY (${omzetExpr}) ASC, t.transaction_no ASC`;
	} else {
		dateFilterSql = `DATE(t.service_date) >= ?
        AND DATE(t.service_date) <= ?`;
		orderBySql = ` ORDER BY t.service_date ASC, t.transaction_no ASC`;
	}

	let sql = `
      SELECT
        t.id,
        t.transaction_no,
        t.customer_name,
        t.customer_phone,
        t.service_date,
        t.final_amount,
        t.status,
        t.payment_status,
        DATE_FORMAT(t.payment_settled_date, '%Y-%m-%d') AS payment_settled_date,
        DATE_FORMAT((${omzetExpr}), '%Y-%m-%d') AS omzet_date,
        t.notes,
        t.created_at,
        t.is_history_entry,
        pm.\`group\` AS payment_method_group,
        pm.label AS payment_method_label,
        t.paid_amount,
        t.compensation_reason,
        t.compensation_chronology,
        t.compensation_complaint_id,
        t.compensation_complaint_nota,
        t.compensation_complaint_name,
        t.compensation_complaint_outlet
      FROM tr_transactions t
      LEFT JOIN mst_payment_method pm ON pm.id = t.payment_method_id
      WHERE ${dateFilterSql}`;
	const params = [startDate, endDate];

	if (status) {
		sql += ` AND t.status = ?`;
		params.push(status);
	} else {
		sql += ` AND t.status <> 'Cancelled'`;
	}

	if (paymentStatus === "terbayar") {
		sql += ` AND t.payment_status IN ('lunas', 'dp')`;
	} else if (paymentStatus === "lunas") {
		sql += ` AND t.payment_status = ?`;
		params.push("lunas");
	} else if (paymentStatus === "belum_lunas") {
		sql += ` AND (t.payment_status IN ('belum_lunas', 'dp') OR t.payment_status IS NULL OR t.payment_status = '')`;
	}

	if (serviceMode === "take_home") {
		sql += ` AND t.service_mode = 'take_home'`;
	} else if (serviceMode === "home_service") {
		sql += ` AND (t.service_mode = 'home_service' OR t.service_mode IS NULL OR t.service_mode = '')`;
	}

	if (search) {
		sql += ` AND (
        t.transaction_no LIKE ?
        OR t.customer_name LIKE ?
        OR COALESCE(t.customer_phone, '') LIKE ?
      )`;
		const like = `%${search}%`;
		params.push(like, like, like);
	}

	sql += orderBySql;

	const [rows] = await safeCleanoxQuery(sql, params);
	const proofsByTx = await loadProofsByTransactionIds(
		(rows || []).map((r) => Number(r.id)).filter((id) => Number.isInteger(id) && id > 0),
	);

	return res.json(buildListResponse(rows || [], proofsByTx, { defaultSource: "pos" }));
}

async function listUnifiedRiwayat({
	res,
	startDate,
	endDate,
	search,
	status,
	paymentStatus,
	dateBy,
	serviceMode,
	splitPayment = false,
}) {
	const omzetExpr = buildOmzetDateExpr("v");
	let dateFilterSql;
	let orderBySql;
	if (dateBy === "settled") {
		dateFilterSql = `v.payment_settled_date IS NOT NULL
        AND v.payment_settled_date >= ?
        AND v.payment_settled_date <= ?`;
		orderBySql = ` ORDER BY v.payment_settled_date ASC, v.transaction_no ASC`;
	} else if (dateBy === "omzet") {
		dateFilterSql = `(${omzetExpr}) >= ?
        AND (${omzetExpr}) <= ?`;
		orderBySql = ` ORDER BY (${omzetExpr}) ASC, v.transaction_no ASC`;
	} else {
		dateFilterSql = `DATE(v.service_date) >= ?
        AND DATE(v.service_date) <= ?`;
		orderBySql = ` ORDER BY v.service_date ASC, v.transaction_no ASC`;
	}

	let sql = `
      SELECT
        v.id,
        v.pos_transaction_id,
        v.source_system,
        v.transaction_no,
        v.customer_name,
        v.customer_phone,
        v.service_date,
        v.final_amount,
        v.status,
        v.payment_status,
        DATE_FORMAT(v.payment_settled_date, '%Y-%m-%d') AS payment_settled_date,
        DATE_FORMAT((${omzetExpr}), '%Y-%m-%d') AS omzet_date,
        v.created_at,
        v.is_history_entry,
        v.payment_method_label,
        pm.\`group\` AS payment_method_group,
        tx.paid_amount,
        tx.compensation_reason,
        tx.compensation_chronology,
        tx.compensation_complaint_id,
        tx.compensation_complaint_nota,
        tx.compensation_complaint_name,
        tx.compensation_complaint_outlet
      FROM v_transactions_unified v
      LEFT JOIN mst_payment_method pm ON pm.id = v.payment_method_id
      LEFT JOIN tr_transactions tx
        ON v.source_system = 'pos' AND tx.id = v.pos_transaction_id
      WHERE ${dateFilterSql}`;
	const params = [startDate, endDate];

	if (status) {
		sql += ` AND v.status = ?`;
		params.push(status);
	} else {
		sql += ` AND (v.source_system = 'smartlink' OR v.status <> 'Cancelled')`;
	}

	if (paymentStatus === "terbayar") {
		sql += ` AND v.payment_status IN ('lunas', 'dp')`;
	} else if (paymentStatus === "lunas") {
		sql += ` AND v.payment_status = ?`;
		params.push("lunas");
	} else if (paymentStatus === "belum_lunas") {
		sql += ` AND (v.payment_status IN ('belum_lunas', 'dp') OR v.payment_status IS NULL OR v.payment_status = '')`;
	}

	if (serviceMode === "take_home") {
		sql += ` AND v.source_system = 'pos' AND v.service_mode = 'take_home'`;
	} else if (serviceMode === "home_service") {
		sql += ` AND v.source_system = 'pos'
      AND (v.service_mode = 'home_service' OR v.service_mode IS NULL OR v.service_mode = '')`;
	}

	if (search) {
		sql += ` AND (
        v.transaction_no LIKE ?
        OR v.customer_name LIKE ?
        OR COALESCE(v.customer_phone, '') LIKE ?
      )`;
		const like = `%${search}%`;
		params.push(like, like, like);
	}

	sql += orderBySql;

	const [rows] = await safeCleanoxQuery(sql, params);

	const posIds = (rows || [])
		.filter((r) => String(r.source_system || "") === "pos")
		.map((r) => Number(r.pos_transaction_id || r.id))
		.filter((id) => Number.isInteger(id) && id > 0);

	const proofsByTx = await loadProofsByTransactionIds(posIds);
	const paymentGroupsByTx = splitPayment
		? await loadPaymentGroupsByTransactionIds(posIds)
		: new Map();

	return res.json(
		buildListResponse(rows || [], proofsByTx, {
			defaultSource: null,
			splitPayment,
			terbayarMode: paymentStatus === "terbayar",
			paymentGroupsByTx,
		}),
	);
}

async function loadProofsByTransactionIds(ids) {
	const proofsByTx = new Map();
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return proofsByTx;

	const placeholders = uniqueIds.map(() => "?").join(",");
	const [proofRows] = await safeCleanoxQuery(
		`
			SELECT id, transaction_id, photo_file, sort_order
			FROM tr_transaction_payment_proofs
			WHERE transaction_id IN (${placeholders})
			ORDER BY sort_order ASC, id ASC
		`,
		uniqueIds,
	);

	for (const p of proofRows || []) {
		const txId = Number(p.transaction_id);
		if (!proofsByTx.has(txId)) proofsByTx.set(txId, []);
		proofsByTx.get(txId).push({
			id: Number(p.id),
			photo_file: p.photo_file,
			url: buildPaymentProofUrl(p.photo_file),
		});
	}
	return proofsByTx;
}

function roundMoney(value) {
	return Number(Number(value || 0).toFixed(2));
}

/**
 * Pembayaran aktif POS per nota, urut tanggal bayar lalu id.
 * @returns {Map<number, Array<{ kategori: string, group: string, label: string|null, amount: number }>>}
 */
async function loadPaymentGroupsByTransactionIds(ids) {
	const groupsByTx = new Map();
	const uniqueIds = [...new Set(ids)];
	if (uniqueIds.length === 0) return groupsByTx;

	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeCleanoxQuery(
		`
			SELECT p.transaction_id, p.amount, pm.\`group\` AS method_group, pm.label AS method_label
			FROM tr_transaction_payments p
			INNER JOIN mst_payment_method pm ON pm.id = p.payment_method_id
			WHERE p.transaction_id IN (${placeholders}) AND p.voided_at IS NULL
			ORDER BY p.paid_date ASC, p.id ASC
		`,
		uniqueIds,
	);
	for (const row of rows || []) {
		const txId = Number(row.transaction_id);
		if (!groupsByTx.has(txId)) groupsByTx.set(txId, []);
		groupsByTx.get(txId).push({
			kategori: mapKategori(row.method_group),
			group: row.method_group,
			label: row.method_label || null,
			amount: Number(row.amount),
		});
	}
	return groupsByTx;
}

/**
 * Bagi nominal satu nota (maksimum `cap`) per kelompok metode pembayaran, berurutan sesuai
 * pembayaran. Mengembalikan null bila hanya ada satu kelompok (baris tidak perlu dipecah).
 */
function splitAmountByPaymentGroup(payments, cap) {
	if (!payments || payments.length === 0) return null;
	const byKategori = new Map();
	let capLeft = cap;
	for (const payment of payments) {
		const take = Math.min(payment.amount, capLeft);
		if (take <= 0) continue;
		capLeft -= take;
		const existing = byKategori.get(payment.kategori);
		if (existing) existing.amount += take;
		else byKategori.set(payment.kategori, { ...payment, amount: take });
	}
	return byKategori.size > 1
		? [...byKategori.values()].map((split) => ({ ...split, amount: roundMoney(split.amount) }))
		: null;
}

/**
 * terbayarMode (payment_status=terbayar, dipakai Pendapatan): `final_amount` = nominal yang sudah terbayar
 * (maksimum sebesar tagihan); `tagihan_amount` selalu berisi tagihan penuh.
 */
function buildListResponse(
	rows,
	proofsByTx,
	{ defaultSource, splitPayment = false, terbayarMode = false, paymentGroupsByTx = new Map() },
) {
	let totalAmount = 0;
	let lunasCount = 0;
	let belumLunasCount = 0;
	let tunaiAmount = 0;
	let nonTunaiAmount = 0;
	let smartlinkAmount = 0;

	const addCategoryAmount = (kategori, amount) => {
		if (isTunaiKategori(kategori)) tunaiAmount += amount;
		else if (isNonTunaiSummaryKategori(kategori)) nonTunaiAmount += amount;
		else if (kategori === "SMARTLINK") smartlinkAmount += amount;
	};

	const data = [];
	for (const row of rows || []) {
		const tagihanAmount = Number(row.final_amount || 0);
		const sourceSystem = row.source_system || defaultSource || "pos";
		const isPos = sourceSystem === "pos";
		const paidAmount = isPos ? Number(row.paid_amount || 0) : tagihanAmount;
		const amount = terbayarMode ? Math.min(paidAmount, tagihanAmount) : tagihanAmount;
		const kategori = mapKategoriUnified(row.payment_method_group, sourceSystem);
		const payStatus = row.payment_status || "belum_lunas";
		const txId = Number(row.pos_transaction_id || row.id) || null;
		const isHistory = Boolean(Number(row.is_history_entry || 0));

		totalAmount += amount;
		if (payStatus === "lunas") lunasCount += 1;
		else belumLunasCount += 1;

		const proofs = isPos && txId ? proofsByTx.get(txId) || [] : [];

		const base = {
			id: txId,
			transaction_no: row.transaction_no,
			customer_name: row.customer_name || "-",
			customer_phone: row.customer_phone || null,
			service_date: row.service_date,
			service_date_key: toDateOnly(row.service_date),
			omzet_date: row.omzet_date || null,
			final_amount: amount,
			tagihan_amount: tagihanAmount,
			paid_amount: paidAmount,
			remaining_amount: Math.max(0, tagihanAmount - paidAmount),
			pricing_pending: false,
			status: row.status,
			payment_status: payStatus,
			payment_settled_date: row.payment_settled_date || null,
			notes: row.notes || null,
			created_at: row.created_at,
			payment_method_group: row.payment_method_group || null,
			payment_method_label: row.payment_method_label || null,
			compensation_reason: row.compensation_reason || null,
			compensation_chronology: row.compensation_chronology || null,
			compensation_complaint_id: row.compensation_complaint_id ?? null,
			compensation_complaint_nota: row.compensation_complaint_nota || null,
			compensation_complaint_name: row.compensation_complaint_name || null,
			compensation_complaint_outlet: row.compensation_complaint_outlet || null,
			source_system: sourceSystem,
			is_history_entry: isHistory,
			kategori,
			payment_proofs: proofs,
			split_index: null,
			split_total: null,
		};

		const splits =
			splitPayment && isPos
				? splitAmountByPaymentGroup(paymentGroupsByTx.get(txId), amount)
				: null;

		if (splits) {
			splits.forEach((split, index) => {
				data.push({
					...base,
					final_amount: split.amount,
					kategori: split.kategori,
					payment_method_group: split.group,
					payment_method_label: split.label,
					payment_proofs: index === 0 ? proofs : [],
					split_index: index + 1,
					split_total: splits.length,
				});
				addCategoryAmount(split.kategori, split.amount);
			});
		} else {
			data.push(base);
			addCategoryAmount(kategori, amount);
		}
	}

	return {
		data,
		summary: {
			total_transactions: (rows || []).length,
			total_rows: data.length,
			total_amount: totalAmount,
			lunas_count: lunasCount,
			belum_lunas_count: belumLunasCount,
			tunai_amount: tunaiAmount,
			non_tunai_amount: nonTunaiAmount,
			smartlink_amount: smartlinkAmount,
		},
	};
}

/**
 * GET /cleanox/riwayat-transaksi/payment-proofs/:filename
 */
export async function servePaymentProof(req, res) {
	try {
		if (!CLEANOX_PAYMENT_PROOF_DIR) {
			return res.status(500).json({ message: "CLEANOX_BASE_DIR belum dikonfigurasi" });
		}

		const safeFileName = path.basename(String(req.params.filename || ""));
		if (!safeFileName) {
			return res.status(400).json({ message: "Nama file tidak valid" });
		}

		const fullPath = path.join(CLEANOX_PAYMENT_PROOF_DIR, safeFileName);
		const resolvedDir = path.resolve(CLEANOX_PAYMENT_PROOF_DIR);
		const resolvedFile = path.resolve(fullPath);
		if (!resolvedFile.startsWith(resolvedDir + path.sep) || !fs.existsSync(resolvedFile)) {
			return res.status(404).json({ message: "File bukti tidak ditemukan" });
		}

		res.setHeader("Cache-Control", "private, max-age=300");
		return res.sendFile(resolvedFile);
	} catch (err) {
		console.error("[servePaymentProof Cleanox Riwayat]:", err);
		return res.status(500).json({ message: "Gagal membuka file bukti" });
	}
}
