import fs from "fs";
import path from "path";
import { safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_PAYMENT_PROOF_DIR } from "../../middleware/upload.js";

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

export function mapKategori(group) {
	const g = String(group || "").trim();
	if (!g) return "-";
	if (g.toLowerCase() === "tunai") return "TUNAI";
	if (g.toLowerCase() === "collaboration") return "COLLABORATION";
	if (["bca", "edc", "qris"].includes(g.toLowerCase())) return "TF BANK";
	return "TF BANK";
}

function buildPaymentProofUrl(photoFile) {
	if (!photoFile) return null;
	return `/cleanox/riwayat-transaksi/payment-proofs/${encodeURIComponent(path.basename(String(photoFile)))}`;
}

/**
 * GET /cleanox/riwayat-transaksi
 * POS-only riwayat by date range (SuperApp cutoff).
 * Query date_by: `service` (default) = service_date; `settled` = payment_settled_date.
 */
export async function listRiwayatTransaksi(req, res) {
	try {
		const startDate = toISODateString(req.query.startDate);
		const endDate = toISODateString(req.query.endDate);
		const search = String(req.query.search || "").trim();
		const status = String(req.query.status || "").trim();
		const paymentStatus = String(req.query.payment_status || "").trim();
		const dateBy =
			String(req.query.date_by || "").trim().toLowerCase() === "settled"
				? "settled"
				: "service";
		const serviceModeRaw = String(req.query.service_mode || "").trim().toLowerCase();
		const serviceMode =
			serviceModeRaw === "home_service" || serviceModeRaw === "take_home"
				? serviceModeRaw
				: serviceModeRaw === "all" || !serviceModeRaw
					? "all"
					: "all";

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

		// pricing_pending belum ada di skema cleanox_pos_prod saat ini — jangan SELECT.
		const dateFilterSql =
			dateBy === "settled"
				? `t.payment_settled_date IS NOT NULL
        AND t.payment_settled_date >= ?
        AND t.payment_settled_date <= ?`
				: `DATE(t.service_date) >= ?
        AND DATE(t.service_date) <= ?`;
		const orderBySql =
			dateBy === "settled"
				? ` ORDER BY t.payment_settled_date ASC, t.transaction_no ASC`
				: ` ORDER BY t.service_date ASC, t.transaction_no ASC`;

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
        t.notes,
        t.created_at,
        pm.\`group\` AS payment_method_group,
        pm.label AS payment_method_label
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

		if (paymentStatus === "lunas") {
			sql += ` AND t.payment_status = ?`;
			params.push("lunas");
		} else if (paymentStatus === "belum_lunas") {
			sql += ` AND (t.payment_status = 'belum_lunas' OR t.payment_status IS NULL OR t.payment_status = '')`;
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

		const ids = (rows || []).map((r) => Number(r.id)).filter((id) => Number.isInteger(id) && id > 0);
		const proofsByTx = new Map();

		if (ids.length > 0) {
			const placeholders = ids.map(() => "?").join(",");
			const [proofRows] = await safeCleanoxQuery(
				`
					SELECT id, transaction_id, photo_file, sort_order
					FROM tr_transaction_payment_proofs
					WHERE transaction_id IN (${placeholders})
					ORDER BY sort_order ASC, id ASC
				`,
				ids,
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
		}

		let totalAmount = 0;
		let lunasCount = 0;
		let belumLunasCount = 0;
		let tunaiAmount = 0;
		let nonTunaiAmount = 0;

		const data = (rows || []).map((row) => {
			const amount = Number(row.final_amount || 0);
			const pending = false;
			const kategori = mapKategori(row.payment_method_group);
			const payStatus = row.payment_status || "belum_lunas";
			const txId = Number(row.id);

			totalAmount += amount;
			if (payStatus === "lunas") lunasCount += 1;
			else belumLunasCount += 1;

			if (kategori === "TUNAI") tunaiAmount += amount;
			else if (kategori === "TF BANK") nonTunaiAmount += amount;

			return {
				id: txId,
				transaction_no: row.transaction_no,
				customer_name: row.customer_name || "-",
				customer_phone: row.customer_phone || null,
				service_date: row.service_date,
				service_date_key: toDateOnly(row.service_date),
				final_amount: amount,
				pricing_pending: pending,
				status: row.status,
				payment_status: payStatus,
				payment_settled_date: row.payment_settled_date || null,
				notes: row.notes || null,
				created_at: row.created_at,
				payment_method_group: row.payment_method_group || null,
				payment_method_label: row.payment_method_label || null,
				kategori,
				payment_proofs: proofsByTx.get(txId) || [],
			};
		});

		return res.json({
			data,
			summary: {
				total_transactions: data.length,
				total_amount: totalAmount,
				lunas_count: lunasCount,
				belum_lunas_count: belumLunasCount,
				tunai_amount: tunaiAmount,
				non_tunai_amount: nonTunaiAmount,
			},
		});
	} catch (err) {
		console.error("[listRiwayatTransaksi Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memuat riwayat transaksi POS" });
	}
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
