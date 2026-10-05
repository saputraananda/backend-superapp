import path from "path";
import { safeQuery, safeCleanoxQuery, cleanoxPool } from "../../db/pool.js";
import { getCleanoxProduksiEmployeeIds } from "./utils/cleanoxProduksiEmployees.js";
import { getCleanoxMealRates, listCleanoxMealRateRows } from "./utils/cleanoxMealRates.js";
import { getOffDayMap, getApprovedLeaveMap } from "./utils/cleanoxMealCalendar.js";

const CLEANOX_COMPANY_ID = 3;
const MAX_RANGE_DAYS = 31;
const ALLOWED_TYPES = new Set(["half_day", "full_day", "office"]);
const REQUEST_STATUSES = new Set(["diajukan", "sebagian_tf", "selesai"]);
const TRANSFER_MODES = new Set(["individual", "combined"]);
const RATE_CODES = new Set(["office", "half_day", "full_day"]);
const RATE_LABELS = { office: "Kantor", half_day: "Half Day", full_day: "Full Day" };
const MAX_RATE_AMOUNT = 10000000;

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
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

function todayDateStringWib() {
	const now = new Date();
	const utc = now.getTime() + now.getTimezoneOffset() * 60000;
	const jakarta = new Date(utc + 7 * 60 * 60000);
	return jakarta.toISOString().slice(0, 10);
}

function eachDateInclusive(startDate, endDate) {
	const out = [];
	const [sy, sm, sd] = startDate.split("-").map(Number);
	const [ey, em, ed] = endDate.split("-").map(Number);
	const cur = new Date(Date.UTC(sy, sm - 1, sd));
	const end = new Date(Date.UTC(ey, em - 1, ed));
	while (cur <= end) {
		const y = cur.getUTCFullYear();
		const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
		const d = String(cur.getUTCDate()).padStart(2, "0");
		out.push(`${y}-${m}-${d}`);
		cur.setUTCDate(cur.getUTCDate() + 1);
	}
	return out;
}

function toActorName(value) {
	const actor = String(value || "").trim().slice(0, 255);
	return actor || null;
}

function resolveActorName(req) {
	return (
		toActorName(req.session?.user?.employee?.full_name) ||
		toActorName(req.session?.user?.name) ||
		toActorName(req.session?.userName) ||
		toActorName(req.session?.user?.username) ||
		"admin"
	);
}

function resolveActorId(req) {
	const candidates = [
		req.session?.user?.id,
		req.session?.user?.user_id,
		req.session?.userId,
		req.session?.id,
	];
	for (const c of candidates) {
		const n = toPositiveInt(c);
		if (n) return n;
	}
	return null;
}

function buildProofUrl(fileName) {
	if (!fileName) return null;
	if (String(fileName).startsWith("/cleanox/meal/proofs/")) return fileName;
	return `/cleanox/meal/proofs/${encodeURIComponent(path.basename(fileName))}`;
}

function isDuplicateKeyError(err) {
	return Number(err?.errno) === 1062 || String(err?.code || "") === "ER_DUP_ENTRY";
}

function validatePeriod(startDate, endDate) {
	if (!startDate || !endDate) return "Periode wajib diisi (YYYY-MM-DD)";
	if (startDate > endDate) return "Tanggal mulai tidak boleh setelah tanggal selesai";
	if (endDate > todayDateStringWib()) return "Tanggal tidak boleh di masa depan";
	if (eachDateInclusive(startDate, endDate).length > MAX_RANGE_DAYS) {
		return `Rentang maksimal ${MAX_RANGE_DAYS} hari`;
	}
	return null;
}

async function getProduksiWorkers(ids) {
	const produksiIds = await getCleanoxProduksiEmployeeIds();
	const filterIds = Array.isArray(ids)
		? produksiIds.filter((id) => ids.includes(id))
		: produksiIds;
	if (filterIds.length === 0) return [];

	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name,
				e.bank_account_number,
				b.bank_name,
				p.position_name,
				j.job_level_name
			FROM mst_employee e
			LEFT JOIN mst_bank b ON b.bank_id = e.bank_id
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			WHERE e.is_deleted = 0
				AND e.company_id = ?
				AND e.exit_date IS NULL
				AND e.employee_id IN (${filterIds.map(() => "?").join(",")})
			ORDER BY e.full_name ASC
		`,
		[CLEANOX_COMPANY_ID, ...filterIds]
	);

	const bankAccountMap = await getWorkerBankAccountMap(filterIds);

	return (rows || []).map((row) => {
		const acc = bankAccountMap.get(Number(row.employee_id));
		const base = {
			employee_id: Number(row.employee_id),
			employee_code: row.employee_code || null,
			full_name: row.full_name || `ID ${row.employee_id}`,
			jabatan: row.job_level_name || row.position_name || "-",
		};
		if (acc) {
			return {
				...base,
				bank_name: acc.bank_name,
				bank_account_number: acc.bank_account_number,
				bank_source: "cleanox",
				bank_updated_by_name: acc.updated_by_name || null,
				bank_updated_at: acc.updated_at || null,
			};
		}
		return {
			...base,
			bank_name: row.bank_name || null,
			bank_account_number: row.bank_account_number || null,
			bank_source: row.bank_name || row.bank_account_number ? "superapp" : null,
			bank_updated_by_name: null,
			bank_updated_at: null,
		};
	});
}

async function getWorkerBankAccountMap(employeeIds) {
	const map = new Map();
	if (!employeeIds || employeeIds.length === 0) return map;
	const [rows] = await safeCleanoxQuery(
		`
			SELECT employee_id, bank_name, bank_account_number, updated_by_name, updated_at
			FROM mst_worker_bank_account
			WHERE employee_id IN (${employeeIds.map(() => "?").join(",")})
		`,
		employeeIds
	);
	for (const row of rows || []) {
		map.set(Number(row.employee_id), row);
	}
	return map;
}

async function getEmployeeBasicMap(workerIds) {
	const ids = [...new Set(workerIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
	const map = new Map();
	if (ids.length === 0) return map;
	const [rows] = await safeQuery(
		`
			SELECT e.employee_id, e.employee_code, e.full_name, p.position_name, j.job_level_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			WHERE e.company_id = ?
				AND e.employee_id IN (${ids.map(() => "?").join(",")})
		`,
		[CLEANOX_COMPANY_ID, ...ids]
	);
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_code: row.employee_code || null,
			full_name: row.full_name || `ID ${row.employee_id}`,
			jabatan: row.job_level_name || row.position_name || "-",
		});
	}
	return map;
}

async function recomputeRequestStatus(conn, requestId) {
	const run = (sql, params) => (conn ? conn.query(sql, params) : safeCleanoxQuery(sql, params));
	const [[counts]] = await run(
		`
			SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN status = 'selesai' THEN 1 ELSE 0 END) AS done
			FROM tr_worker_meal_transfer
			WHERE request_id = ?
		`,
		[requestId]
	);
	const total = Number(counts?.total || 0);
	const done = Number(counts?.done || 0);
	const status = total > 0 && done === total ? "selesai" : done > 0 ? "sebagian_tf" : "diajukan";
	await run(`UPDATE tr_worker_meal_request SET status = ?, updated_at = NOW() WHERE id = ?`, [
		status,
		requestId,
	]);
	return status;
}

function mapRequest(row) {
	return {
		id: row.id,
		request_no: row.request_no,
		period_start: toDateOnly(row.period_start),
		period_end: toDateOnly(row.period_end),
		status: row.status,
		transfer_mode: row.transfer_mode || "individual",
		total_workers: Number(row.total_workers || 0),
		total_days: Number(row.total_days || 0),
		total_amount: Number(row.total_amount || 0),
		notes: row.notes,
		created_by: row.created_by,
		created_by_name: row.created_by_name,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

function mapTransfer(row, emp = {}) {
	return {
		id: row.id,
		request_id: row.request_id,
		worker_id: row.worker_id,
		recipient_worker_id: Number(row.recipient_worker_id || row.worker_id),
		is_combined: row.recipient_worker_id != null,
		employee_code: emp.employee_code || null,
		full_name: emp.full_name || row.account_name || `ID ${row.worker_id}`,
		jabatan: emp.jabatan || "-",
		half_days: Number(row.half_days || 0),
		full_days: Number(row.full_days || 0),
		office_days: Number(row.office_days || 0),
		amount: Number(row.amount || 0),
		bank_name: row.bank_name,
		bank_account_number: row.bank_account_number,
		account_name: row.account_name,
		status: row.status,
		proof_file: row.proof_file,
		proof_path: row.proof_path,
		proof_url: buildProofUrl(row.proof_file || row.proof_path),
		process_note: row.process_note,
		processed_by: row.processed_by,
		processed_by_name: row.processed_by_name,
		processed_at: row.processed_at,
	};
}

export const getMealRates = async (_req, res) => {
	try {
		return res.json({ rows: await listCleanoxMealRateRows() });
	} catch (err) {
		console.error("[getMealRates Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil tarif uang makan" });
	}
};

export const updateMealRate = async (req, res) => {
	try {
		const code = String(req.params.code || "").trim();
		if (!RATE_CODES.has(code)) {
			return res.status(400).json({ message: "Kode tarif tidak valid. Gunakan: office, half_day, full_day" });
		}
		const amount = Number(req.body?.amount);
		if (!Number.isInteger(amount) || amount < 0 || amount > MAX_RATE_AMOUNT) {
			return res.status(400).json({ message: "Nominal tarif tidak valid" });
		}

		const actorId = resolveActorId(req);
		const actorName = resolveActorName(req);
		await safeCleanoxQuery(
			`
				INSERT INTO mst_worker_meal_rate (code, label, amount, updated_by, updated_by_name, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, NOW(), NOW())
				ON DUPLICATE KEY UPDATE
					amount = VALUES(amount),
					updated_by = VALUES(updated_by),
					updated_by_name = VALUES(updated_by_name),
					updated_at = NOW()
			`,
			[code, RATE_LABELS[code], amount, actorId, actorName]
		);

		return res.json({ message: "Tarif diperbarui", rows: await listCleanoxMealRateRows() });
	} catch (err) {
		console.error("[updateMealRate Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memperbarui tarif" });
	}
};

export const listBanks = async (_req, res) => {
	try {
		const [rows] = await safeQuery(
			`SELECT bank_id, bank_name FROM mst_bank WHERE is_active = 1 ORDER BY bank_name ASC`
		);
		return res.json({ rows: rows || [] });
	} catch (err) {
		console.error("[listBanks Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memuat daftar bank" });
	}
};

export const upsertWorkerBankAccount = async (req, res) => {
	try {
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) {
			return res.status(400).json({ message: "ID karyawan tidak valid" });
		}
		const bankName = String(req.body?.bank_name || "").trim();
		const accountNumber = String(req.body?.bank_account_number || "").replace(/\s+/g, "");
		if (!bankName) {
			return res.status(400).json({ message: "Bank wajib dipilih" });
		}
		if (!/^\d{5,30}$/.test(accountNumber)) {
			return res.status(400).json({ message: "No. rekening harus 5–30 digit angka" });
		}

		const [bankRows] = await safeQuery(
			`SELECT 1 FROM mst_bank WHERE is_active = 1 AND TRIM(bank_name) = ? LIMIT 1`,
			[bankName]
		);
		if (!bankRows || bankRows.length === 0) {
			return res.status(400).json({ message: "Bank tidak terdaftar" });
		}

		const workers = await getProduksiWorkers([employeeId]);
		if (workers.length !== 1) {
			return res.status(404).json({ message: "Karyawan produksi tidak ditemukan" });
		}

		await safeCleanoxQuery(
			`
				INSERT INTO mst_worker_bank_account (employee_id, bank_name, bank_account_number, updated_by, updated_by_name)
				VALUES (?, ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE
					bank_name = VALUES(bank_name),
					bank_account_number = VALUES(bank_account_number),
					updated_by = VALUES(updated_by),
					updated_by_name = VALUES(updated_by_name),
					updated_at = NOW()
			`,
			[employeeId, bankName, accountNumber, resolveActorId(req), resolveActorName(req)]
		);

		const [worker] = await getProduksiWorkers([employeeId]);
		return res.json({ message: "Rekening diperbarui", worker });
	} catch (err) {
		console.error("[upsertWorkerBankAccount Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menyimpan rekening" });
	}
};

export const getPlotContext = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate);
		const endDate = toISODateString(req.query.endDate);
		const periodError = validatePeriod(startDate, endDate);
		if (periodError) return res.status(400).json({ message: periodError });

		const [rates, workers] = await Promise.all([getCleanoxMealRates(), getProduksiWorkers()]);
		const workerIds = workers.map((w) => w.employee_id);

		let existing = [];
		if (workerIds.length > 0) {
			const [rows] = await safeCleanoxQuery(
				`
					SELECT worker_id, meal_date, type, status, request_id
					FROM tr_worker_meal
					WHERE meal_date >= ? AND meal_date <= ?
						AND worker_id IN (${workerIds.map(() => "?").join(",")})
				`,
				[startDate, endDate, ...workerIds]
			);
			existing = (rows || []).map((r) => ({
				worker_id: Number(r.worker_id),
				meal_date: toDateOnly(r.meal_date),
				type: r.type,
				status: r.status,
				request_id: r.request_id ?? null,
			}));
		}

		const offMap = await getOffDayMap(workerIds, startDate, endDate);
		const leaveMap = await getApprovedLeaveMap(workerIds, startDate, endDate);

		const off_days = [];
		for (const [wid, dates] of offMap.entries()) {
			for (const d of dates) off_days.push({ worker_id: wid, off_date: d });
		}
		const leaves = [];
		for (const [wid, dates] of leaveMap.entries()) {
			for (const [d, leaveType] of dates.entries()) {
				leaves.push({ worker_id: wid, date: d, leave_type: leaveType });
			}
		}

		return res.json({
			startDate,
			endDate,
			dates: eachDateInclusive(startDate, endDate),
			rates,
			workers,
			existing,
			off_days,
			leaves,
		});
	} catch (err) {
		console.error("[getPlotContext Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memuat data plot uang makan" });
	}
};

export const listMealRequests = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate);
		const endDate = toISODateString(req.query.endDate);
		const status = String(req.query.status || "").toLowerCase();
		if (status && !REQUEST_STATUSES.has(status)) {
			return res.status(400).json({ message: "Status tidak valid. Gunakan: diajukan, sebagian_tf, selesai" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(100, Math.max(1, toPositiveInt(req.query.limit) || 20));
		const offset = (page - 1) * limit;

		const where = ["1=1"];
		const params = [];
		if (startDate && endDate) {
			where.push("r.period_start <= ? AND r.period_end >= ?");
			params.push(endDate, startDate);
		}
		const summaryWhere = where.join(" AND ");
		const summaryParams = [...params];
		if (status) {
			where.push("r.status = ?");
			params.push(status);
		}
		const whereSql = where.join(" AND ");

		const [[countRow]] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_meal_request r WHERE ${whereSql}`,
			params
		);
		const total = Number(countRow?.total || 0);

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					r.*,
					(SELECT COUNT(DISTINCT COALESCE(t.recipient_worker_id, t.worker_id)) FROM tr_worker_meal_transfer t WHERE t.request_id = r.id) AS transfers_total,
					(SELECT COUNT(DISTINCT CASE WHEN t.status = 'selesai' THEN COALESCE(t.recipient_worker_id, t.worker_id) END) FROM tr_worker_meal_transfer t WHERE t.request_id = r.id) AS transfers_done
				FROM tr_worker_meal_request r
				WHERE ${whereSql}
				ORDER BY r.period_start DESC, r.id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const [[summaryRow]] = await safeCleanoxQuery(
			`
				SELECT
					SUM(CASE WHEN r.status = 'diajukan' THEN 1 ELSE 0 END) AS diajukan,
					SUM(CASE WHEN r.status = 'sebagian_tf' THEN 1 ELSE 0 END) AS sebagian_tf,
					SUM(CASE WHEN r.status = 'selesai' THEN 1 ELSE 0 END) AS selesai,
					COALESCE(SUM(r.total_amount), 0) AS total_amount
				FROM tr_worker_meal_request r
				WHERE ${summaryWhere}
			`,
			summaryParams
		);

		return res.json({
			records: (rows || []).map((row) => ({
				...mapRequest(row),
				transfers_total: Number(row.transfers_total || 0),
				transfers_done: Number(row.transfers_done || 0),
			})),
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
			summary: {
				diajukan: Number(summaryRow?.diajukan || 0),
				sebagian_tf: Number(summaryRow?.sebagian_tf || 0),
				selesai: Number(summaryRow?.selesai || 0),
				total_amount: Number(summaryRow?.total_amount || 0),
			},
		});
	} catch (err) {
		console.error("[listMealRequests Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil daftar pengajuan uang makan" });
	}
};

export const getMealRequestById = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [[request]] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_meal_request WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!request) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });

		const [transferRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_meal_transfer WHERE request_id = ? ORDER BY id ASC`,
			[id]
		);
		const [dayRows] = await safeCleanoxQuery(
			`
				SELECT worker_id, meal_date, type, amount
				FROM tr_worker_meal
				WHERE request_id = ?
				ORDER BY worker_id ASC, meal_date ASC
			`,
			[id]
		);

		const empMap = await getEmployeeBasicMap((transferRows || []).map((t) => t.worker_id));
		const transfers = (transferRows || [])
			.map((t) => mapTransfer(t, empMap.get(Number(t.worker_id))))
			.sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

		return res.json({
			record: mapRequest(request),
			transfers,
			days: (dayRows || []).map((d) => ({
				worker_id: Number(d.worker_id),
				meal_date: toDateOnly(d.meal_date),
				type: d.type,
				amount: Number(d.amount || 0),
			})),
		});
	} catch (err) {
		console.error("[getMealRequestById Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil detail pengajuan" });
	}
};

export const createMealRequest = async (req, res) => {
	const periodStart = toISODateString(req.body?.period_start);
	const periodEnd = toISODateString(req.body?.period_end);
	const periodError = validatePeriod(periodStart, periodEnd);
	if (periodError) return res.status(400).json({ message: periodError });

	const items = Array.isArray(req.body?.items) ? req.body.items : [];
	if (items.length === 0) {
		return res.status(400).json({ message: "Belum ada hari yang diplot" });
	}

	const transferMode = String(req.body?.transfer_mode || "individual").trim().toLowerCase();
	if (!TRANSFER_MODES.has(transferMode)) {
		return res.status(400).json({ message: "Mode transfer tidak valid. Gunakan: individual, combined" });
	}
	const isCombined = transferMode === "combined";

	let connection;
	try {
		const workers = await getProduksiWorkers();
		const workerMap = new Map(workers.map((w) => [w.employee_id, w]));
		if (items.length > MAX_RANGE_DAYS * Math.max(1, workers.length)) {
			return res.status(400).json({ message: "Jumlah item melebihi batas" });
		}

		const periodDates = new Set(eachDateInclusive(periodStart, periodEnd));
		const seen = new Set();
		const normalized = [];
		for (const item of items) {
			const workerId = toPositiveInt(item?.worker_id);
			const mealDate = toISODateString(item?.meal_date);
			const type = String(item?.type || "").trim().toLowerCase();
			if (!workerId || !workerMap.has(workerId)) {
				return res.status(400).json({ message: `Karyawan ID ${item?.worker_id ?? "-"} bukan karyawan produksi aktif` });
			}
			if (!mealDate || !periodDates.has(mealDate)) {
				return res.status(400).json({ message: `Tanggal ${item?.meal_date ?? "-"} di luar periode` });
			}
			if (!ALLOWED_TYPES.has(type)) {
				return res.status(400).json({ message: "Tipe tidak valid. Gunakan: half_day, full_day, office" });
			}
			const key = `${workerId}|${mealDate}`;
			if (seen.has(key)) {
				return res.status(400).json({
					message: `Tanggal ${mealDate} untuk ${workerMap.get(workerId).full_name} diplot lebih dari sekali`,
				});
			}
			seen.add(key);
			normalized.push({ worker_id: workerId, meal_date: mealDate, type });
		}

		const itemWorkerIds = [...new Set(normalized.map((i) => i.worker_id))];
		const [existingRows] = await safeCleanoxQuery(
			`
				SELECT worker_id, meal_date
				FROM tr_worker_meal
				WHERE meal_date >= ? AND meal_date <= ?
					AND worker_id IN (${itemWorkerIds.map(() => "?").join(",")})
			`,
			[periodStart, periodEnd, ...itemWorkerIds]
		);
		const existingKeys = new Set(
			(existingRows || []).map((r) => `${Number(r.worker_id)}|${toDateOnly(r.meal_date)}`)
		);
		const offMap = await getOffDayMap(itemWorkerIds, periodStart, periodEnd);
		const leaveMap = await getApprovedLeaveMap(itemWorkerIds, periodStart, periodEnd);

		const conflicts = [];
		for (const item of normalized) {
			let reason = null;
			if (existingKeys.has(`${item.worker_id}|${item.meal_date}`)) reason = "sudah_diajukan";
			else if (offMap.get(item.worker_id)?.has(item.meal_date)) reason = "libur";
			else if (leaveMap.get(item.worker_id)?.has(item.meal_date)) reason = "cuti_izin";
			if (reason) conflicts.push({ worker_id: item.worker_id, meal_date: item.meal_date, reason });
		}
		if (conflicts.length > 0) {
			return res.status(409).json({ message: "Sebagian tanggal tidak bisa diajukan", conflicts });
		}

		const rates = await getCleanoxMealRates();
		const perWorker = new Map();
		let totalAmount = 0;
		for (const item of normalized) {
			const amount =
				item.type === "half_day" ? rates.half_day : item.type === "full_day" ? rates.full_day : rates.office;
			item.amount = amount;
			totalAmount += amount;
			if (!perWorker.has(item.worker_id)) {
				perWorker.set(item.worker_id, { half_days: 0, full_days: 0, office_days: 0, amount: 0 });
			}
			const agg = perWorker.get(item.worker_id);
			if (item.type === "half_day") agg.half_days += 1;
			else if (item.type === "full_day") agg.full_days += 1;
			else agg.office_days += 1;
			agg.amount += amount;
		}

		let recipientId = null;
		if (isCombined) {
			recipientId = toPositiveInt(req.body?.recipient_worker_id);
			if (!recipientId || !perWorker.has(recipientId)) {
				return res.status(400).json({ message: "Penerima transfer harus salah satu karyawan di pengajuan" });
			}
			if (perWorker.size < 2) {
				return res.status(400).json({ message: "Gabung rekening butuh minimal 2 karyawan" });
			}
		}

		const notes = String(req.body?.notes || "").trim().slice(0, 1000) || null;
		const actorId = resolveActorId(req);
		const actorName = resolveActorName(req);

		connection = await cleanoxPool.getConnection();
		await connection.beginTransaction();

		const [insertResult] = await connection.query(
			`
				INSERT INTO tr_worker_meal_request
					(period_start, period_end, status, transfer_mode, total_workers, total_days, total_amount, notes, created_by, created_by_name, created_at, updated_at)
				VALUES (?, ?, 'diajukan', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
			`,
			[periodStart, periodEnd, transferMode, perWorker.size, normalized.length, totalAmount, notes, actorId, actorName]
		);
		const requestId = insertResult.insertId;

		await connection.query(
			`
				UPDATE tr_worker_meal_request
				SET request_no = CONCAT('UM-', DATE_FORMAT(period_start, '%Y%m%d'), '-', LPAD(id, 4, '0'))
				WHERE id = ?
			`,
			[requestId]
		);

		await connection.query(
			`
				INSERT INTO tr_worker_meal
					(worker_id, request_id, meal_date, type, amount, notes, status, created_at, updated_at)
				VALUES ?
			`,
			[
				normalized.map((i) => [
					i.worker_id,
					requestId,
					i.meal_date,
					i.type,
					i.amount,
					null,
					"menunggu_tf",
					new Date(),
					new Date(),
				]),
			]
		);

		await connection.query(
			`
				INSERT INTO tr_worker_meal_transfer
					(request_id, worker_id, recipient_worker_id, half_days, full_days, office_days, amount, bank_name, bank_account_number, account_name, status, created_at, updated_at)
				VALUES ?
			`,
			[
				[...perWorker.entries()].map(([workerId, agg]) => {
					const recipient = workerMap.get(isCombined ? recipientId : workerId);
					return [
						requestId,
						workerId,
						isCombined ? recipientId : null,
						agg.half_days,
						agg.full_days,
						agg.office_days,
						agg.amount,
						recipient.bank_name,
						recipient.bank_account_number,
						recipient.full_name,
						"menunggu_tf",
						new Date(),
						new Date(),
					];
				}),
			]
		);

		await connection.commit();

		const [[created]] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_meal_request WHERE id = ? LIMIT 1`,
			[requestId]
		);
		return res.status(201).json({
			message: "Pengajuan rapel dikirim ke Finance",
			record: mapRequest(created),
		});
	} catch (err) {
		if (connection) {
			try {
				await connection.rollback();
			} catch {
				// ignore
			}
		}
		if (isDuplicateKeyError(err)) {
			return res.status(409).json({ message: "Sebagian tanggal sudah diajukan, muat ulang data plot" });
		}
		console.error("[createMealRequest Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal membuat pengajuan rapel" });
	} finally {
		if (connection) connection.release();
	}
};

export const deleteMealRequest = async (req, res) => {
	const id = toPositiveInt(req.params.id);
	if (!id) return res.status(400).json({ message: "ID tidak valid" });

	let connection;
	try {
		const [[request]] = await safeCleanoxQuery(
			`SELECT id FROM tr_worker_meal_request WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!request) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });

		const [[doneRow]] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS done FROM tr_worker_meal_transfer WHERE request_id = ? AND status = 'selesai'`,
			[id]
		);
		if (Number(doneRow?.done || 0) > 0) {
			return res.status(400).json({ message: "Pengajuan yang sudah ada transfer selesai tidak bisa dihapus" });
		}

		connection = await cleanoxPool.getConnection();
		await connection.beginTransaction();
		await connection.query(`DELETE FROM tr_worker_meal WHERE request_id = ?`, [id]);
		await connection.query(`DELETE FROM tr_worker_meal_request WHERE id = ?`, [id]);
		await connection.commit();

		return res.json({ message: "Pengajuan dihapus" });
	} catch (err) {
		if (connection) {
			try {
				await connection.rollback();
			} catch {
				// ignore
			}
		}
		console.error("[deleteMealRequest Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menghapus pengajuan" });
	} finally {
		if (connection) connection.release();
	}
};

export const completeMealTransfer = async (req, res) => {
	let connection;
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });
		if (!req.file?.filename) {
			return res.status(400).json({ message: "Bukti TF wajib diunggah" });
		}

		const [[transfer]] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_meal_transfer WHERE id = ? LIMIT 1`,
			[id]
		);
		if (!transfer) return res.status(404).json({ message: "Transfer tidak ditemukan" });
		if (transfer.status !== "menunggu_tf") {
			return res.status(400).json({ message: "Hanya transfer menunggu TF yang bisa diselesaikan" });
		}

		const proofFile = req.file.filename;
		const proofPath = `/cleanox/meal/proofs/${path.basename(proofFile)}`;
		const processNote = String(req.body?.process_note || "").trim().slice(0, 1000) || null;
		const actorId = resolveActorId(req);
		const actorName = resolveActorName(req);

		let group = [{ id: transfer.id, worker_id: transfer.worker_id }];
		if (transfer.recipient_worker_id != null) {
			const [groupRows] = await safeCleanoxQuery(
				`
					SELECT id, worker_id
					FROM tr_worker_meal_transfer
					WHERE request_id = ? AND recipient_worker_id = ? AND status = 'menunggu_tf'
				`,
				[transfer.request_id, transfer.recipient_worker_id]
			);
			group = groupRows || [];
		}
		const groupIds = group.map((g) => Number(g.id));
		const groupWorkerIds = group.map((g) => Number(g.worker_id));

		connection = await cleanoxPool.getConnection();
		await connection.beginTransaction();

		await connection.query(
			`
				UPDATE tr_worker_meal_transfer
				SET status = 'selesai',
					proof_file = ?,
					proof_path = ?,
					process_note = ?,
					processed_by = ?,
					processed_by_name = ?,
					processed_at = NOW(),
					updated_at = NOW()
				WHERE id IN (${groupIds.map(() => "?").join(",")}) AND status = 'menunggu_tf'
			`,
			[proofFile, proofPath, processNote, actorId, actorName, ...groupIds]
		);

		await connection.query(
			`
				UPDATE tr_worker_meal
				SET status = 'selesai',
					proof_file = ?,
					proof_path = ?,
					process_note = ?,
					processed_by = ?,
					processed_by_name = ?,
					processed_at = NOW(),
					updated_at = NOW()
				WHERE request_id = ? AND worker_id IN (${groupWorkerIds.map(() => "?").join(",")})
			`,
			[proofFile, proofPath, processNote, actorId, actorName, transfer.request_id, ...groupWorkerIds]
		);

		await recomputeRequestStatus(connection, transfer.request_id);
		await connection.commit();

		const [[updated]] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_meal_transfer WHERE id = ? LIMIT 1`,
			[id]
		);
		const empMap = await getEmployeeBasicMap([updated.worker_id]);
		return res.json({
			message: "Transfer ditandai selesai",
			transfer: mapTransfer(updated, empMap.get(Number(updated.worker_id))),
			updated_count: group.length,
		});
	} catch (err) {
		if (connection) {
			try {
				await connection.rollback();
			} catch {
				// ignore
			}
		}
		console.error("[completeMealTransfer Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menyelesaikan transfer" });
	} finally {
		if (connection) connection.release();
	}
};
