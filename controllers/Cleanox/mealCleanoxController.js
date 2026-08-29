import fs from "fs";
import path from "path";
import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_MEAL_DIR } from "../../middleware/upload.js";
import {
	getCleanoxProduksiEmployeeIds,
	getCleanoxProduksiRoleMap,
} from "../../utils/cleanoxProduksiEmployees.js";

const CLEANOX_COMPANY_ID = 3;
const ALLOWED_TYPES = new Set(["half_day", "full_day"]);
const ALLOWED_STATUSES = new Set(["menunggu_tf", "selesai"]);
const OFFICE_AMOUNT = 10000;
const HALF_TOTAL = 25000;
const FULL_TOTAL = 30000;

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

function buildProofUrl(fileName) {
	if (!fileName) return null;
	if (String(fileName).startsWith("/cleanox/meal/proofs/")) return fileName;
	return `/cleanox/meal/proofs/${encodeURIComponent(path.basename(fileName))}`;
}

function proofPathFromFilename(filename) {
	if (!filename) return null;
	return `/cleanox/meal/proofs/${path.basename(filename)}`;
}

function toActorName(value) {
	const actor = String(value || "").trim().slice(0, 255);
	return actor || null;
}

function resolveProcessedByName(req) {
	return (
		toActorName(req.body?.processed_by_name) ||
		toActorName(req.session?.user?.employee?.full_name) ||
		toActorName(req.session?.user?.name) ||
		toActorName(req.session?.userName) ||
		toActorName(req.session?.user?.username) ||
		"admin"
	);
}

function resolveProcessedById(req) {
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

function todayDateStringWib() {
	const now = new Date();
	const utc = now.getTime() + now.getTimezoneOffset() * 60000;
	const jakarta = new Date(utc + 7 * 60 * 60000);
	return jakarta.toISOString().slice(0, 10);
}

function amountForType(type) {
	if (type === "half_day") return HALF_TOTAL;
	if (type === "full_day") return FULL_TOTAL;
	return null;
}

function isDuplicateKeyError(err) {
	return Number(err?.errno) === 1062 || String(err?.code || "") === "ER_DUP_ENTRY";
}

async function assertCleanoxProduksiEmployee(workerId) {
	const id = toPositiveInt(workerId);
	if (!id) return null;

	const roleMap = await getCleanoxProduksiRoleMap();
	if (!roleMap.has(id)) return null;

	const [rows] = await safeQuery(
		`
			SELECT employee_id, employee_code, full_name
			FROM mst_employee
			WHERE employee_id = ?
				AND company_id = ?
				AND is_deleted = 0
				AND exit_date IS NULL
			LIMIT 1
		`,
		[id, CLEANOX_COMPANY_ID]
	);

	return rows?.[0] || null;
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

async function getEmployeeMap(workerIds) {
	const uniqueIds = [...new Set(workerIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();

	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`
			SELECT
				e.employee_id,
				e.employee_code,
				e.full_name,
				p.position_name,
				j.job_level_name
			FROM mst_employee e
			LEFT JOIN mst_position p ON p.position_id = e.position_id
			LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
			WHERE e.is_deleted = 0
				AND e.company_id = ?
				AND e.employee_id IN (${placeholders})
		`,
		[CLEANOX_COMPANY_ID, ...uniqueIds]
	);

	const roleMap = new Map();
	try {
		const produksiRoleMap = await getCleanoxProduksiRoleMap();
		for (const [id, role] of produksiRoleMap.entries()) {
			roleMap.set(id, role);
		}
		// Enrich historis: role non-produksi (jika ada di mst_role) tetap dilabeli untuk record lama
		const missingIds = uniqueIds.filter((id) => !roleMap.has(id));
		if (missingIds.length > 0) {
			const ph = missingIds.map(() => "?").join(",");
			const [roleRows] = await safeCleanoxQuery(
				`SELECT employee_id, role FROM mst_role WHERE employee_id IN (${ph})`,
				missingIds
			);
			for (const r of roleRows || []) {
				roleMap.set(Number(r.employee_id), r.role || null);
			}
		}
	} catch {
		// optional
	}

	const map = new Map();
	for (const row of rows || []) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name || null,
			employee_code: row.employee_code || null,
			jabatan: row.job_level_name || row.position_name || "-",
			cleanox_role: roleMap.get(Number(row.employee_id)) || null,
		});
	}
	return map;
}

function mapRecord(row, emp = {}) {
	return {
		id: row.id,
		worker_id: row.worker_id,
		employee_id: row.worker_id,
		full_name: emp.employee_name || `ID ${row.worker_id}`,
		employee_name: emp.employee_name || `ID ${row.worker_id}`,
		employee_code: emp.employee_code || null,
		jabatan: emp.jabatan || "-",
		cleanox_role: emp.cleanox_role || null,
		meal_date: toDateOnly(row.meal_date),
		type: row.type,
		amount: row.amount != null ? Number(row.amount) : null,
		notes: row.notes,
		status: row.status,
		proof_file: row.proof_file,
		proof_path: row.proof_path,
		proof_url: buildProofUrl(row.proof_file || row.proof_path),
		process_note: row.process_note,
		processed_by: row.processed_by,
		processed_by_name: row.processed_by_name,
		processed_at: row.processed_at,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export const listMeals = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate) || null;
		const endDate = toISODateString(req.query.endDate) || null;

		const typeFilter = String(req.query.type || "").toLowerCase();
		if (typeFilter && !ALLOWED_TYPES.has(typeFilter)) {
			return res.status(400).json({ message: "Tipe tidak valid. Gunakan: half_day, full_day" });
		}

		const statusFilter = String(req.query.status || "").toLowerCase();
		if (statusFilter && !ALLOWED_STATUSES.has(statusFilter)) {
			return res.status(400).json({ message: "Status tidak valid. Gunakan: menunggu_tf, selesai" });
		}

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;
		const search = String(req.query.search || "").trim().slice(0, 100);

		const where = ["1=1"];
		const params = [];

		if (startDate) {
			where.push("m.meal_date >= ?");
			params.push(startDate);
		}
		if (endDate) {
			where.push("m.meal_date <= ?");
			params.push(endDate);
		}
		if (typeFilter) {
			where.push("m.type = ?");
			params.push(typeFilter);
		}
		if (statusFilter) {
			where.push("m.status = ?");
			params.push(statusFilter);
		}

		if (search) {
			const like = `%${search}%`;
			const [empRows] = await safeQuery(
				`
					SELECT e.employee_id
					FROM mst_employee e
					WHERE e.is_deleted = 0
						AND e.company_id = ?
						AND (
							e.full_name LIKE ?
							OR e.employee_code LIKE ?
							OR CAST(e.employee_id AS CHAR) LIKE ?
						)
				`,
				[CLEANOX_COMPANY_ID, like, like, like]
			);
			const workerIdFilter = (empRows || []).map((r) => Number(r.employee_id)).filter(Boolean);
			if (workerIdFilter.length === 0) {
				return res.json({
					records: [],
					pagination: { page, limit, total: 0, totalPages: 1 },
					summary: { menunggu_tf: 0, selesai: 0, total: 0 },
				});
			}
			where.push(`m.worker_id IN (${workerIdFilter.map(() => "?").join(",")})`);
			params.push(...workerIdFilter);
		}

		const whereSql = where.join(" AND ");

		const [countRows] = await safeCleanoxQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_meal m WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);
		const totalPages = Math.max(1, Math.ceil(total / limit));

		const [rows] = await safeCleanoxQuery(
			`
				SELECT *
				FROM tr_worker_meal m
				WHERE ${whereSql}
				ORDER BY m.meal_date DESC, m.id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, limit, offset]
		);

		const employeeMap = await getEmployeeMap((rows || []).map((r) => r.worker_id));
		const records = (rows || []).map((row) => {
			const emp = employeeMap.get(Number(row.worker_id)) || {};
			return mapRecord(row, emp);
		});

		const [summaryRows] = await safeCleanoxQuery(
			`
				SELECT
					COUNT(*) AS total,
					COALESCE(SUM(m.amount), 0) AS total_amount,
					SUM(CASE WHEN m.status = 'menunggu_tf' THEN 1 ELSE 0 END) AS menunggu_tf,
					SUM(CASE WHEN m.status = 'selesai' THEN 1 ELSE 0 END) AS selesai
				FROM tr_worker_meal m
				WHERE ${whereSql}
			`,
			params
		);

		return res.json({
			records,
			pagination: { page, limit, total, totalPages },
			summary: {
				total: Number(summaryRows?.[0]?.total || 0),
				total_amount: Number(summaryRows?.[0]?.total_amount || 0),
				menunggu_tf: Number(summaryRows?.[0]?.menunggu_tf || 0),
				selesai: Number(summaryRows?.[0]?.selesai || 0),
			},
		});
	} catch (err) {
		console.error("[listMeals Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil data makan siang Cleanox" });
	}
};

export const getMealRekap = async (req, res) => {
	try {
		const startDate = toISODateString(req.query.startDate);
		const endDate = toISODateString(req.query.endDate);
		if (!startDate || !endDate) {
			return res.status(400).json({ message: "startDate dan endDate wajib (YYYY-MM-DD)" });
		}
		if (startDate > endDate) {
			return res.status(400).json({ message: "startDate tidak boleh setelah endDate" });
		}

		const dates = eachDateInclusive(startDate, endDate);
		const days = dates.length;

		const assignedIds = await getCleanoxProduksiEmployeeIds();
		const roleMap = await getCleanoxProduksiRoleMap();
		if (assignedIds.length === 0) {
			return res.json({
				startDate,
				endDate,
				days,
				rows: [],
				grand_total: 0,
			});
		}

		const ph = assignedIds.map(() => "?").join(",");
		const [employees] = await safeQuery(
			`
				SELECT e.employee_id, e.employee_code, e.full_name
				FROM mst_employee e
				WHERE e.is_deleted = 0
					AND e.company_id = ?
					AND e.exit_date IS NULL
					AND e.employee_id IN (${ph})
				ORDER BY e.full_name ASC
			`,
			[CLEANOX_COMPANY_ID, ...assignedIds]
		);

		const employeeMap = await getEmployeeMap(assignedIds);

		const [mealRows] = await safeCleanoxQuery(
			`
				SELECT worker_id, meal_date, type, amount, status
				FROM tr_worker_meal
				WHERE meal_date >= ? AND meal_date <= ?
					AND worker_id IN (${ph})
			`,
			[startDate, endDate, ...assignedIds]
		);

		const mealMap = new Map();
		for (const row of mealRows || []) {
			const wid = Number(row.worker_id);
			const d = toDateOnly(row.meal_date);
			if (!mealMap.has(wid)) mealMap.set(wid, new Map());
			mealMap.get(wid).set(d, row);
		}

		let grandTotal = 0;
		const rows = (employees || []).map((e) => {
			const workerId = Number(e.employee_id);
			const empMeta = employeeMap.get(workerId) || {};
			const byDate = mealMap.get(workerId) || new Map();
			let officeDays = 0;
			let halfDays = 0;
			let fullDays = 0;
			let totalAmount = 0;

			for (const d of dates) {
				const sub = byDate.get(d);
				if (!sub) {
					officeDays += 1;
					totalAmount += OFFICE_AMOUNT;
				} else if (sub.type === "half_day") {
					halfDays += 1;
					totalAmount += HALF_TOTAL;
				} else if (sub.type === "full_day") {
					fullDays += 1;
					totalAmount += FULL_TOTAL;
				} else {
					officeDays += 1;
					totalAmount += OFFICE_AMOUNT;
				}
			}

			grandTotal += totalAmount;
			return {
				employee_id: workerId,
				worker_id: workerId,
				full_name: e.full_name || `ID ${workerId}`,
				employee_name: e.full_name || `ID ${workerId}`,
				employee_code: e.employee_code || null,
				jabatan: empMeta.jabatan || "-",
				cleanox_role: roleMap.get(workerId) || null,
				days,
				office_days: officeDays,
				half_days: halfDays,
				full_days: fullDays,
				total_amount: totalAmount,
			};
		});

		return res.json({
			startDate,
			endDate,
			days,
			rows,
			grand_total: grandTotal,
		});
	} catch (err) {
		console.error("[getMealRekap Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil rekap makan siang Cleanox" });
	}
};

export const createMeal = async (req, res) => {
	try {
		const workerId = toPositiveInt(req.body?.worker_id);
		if (!workerId) {
			return res.status(400).json({ message: "worker_id wajib diisi" });
		}

		const employee = await assertCleanoxProduksiEmployee(workerId);
		if (!employee) {
			return res.status(404).json({ message: "Karyawan Cleanox tidak ditemukan" });
		}

		const mealDate = toISODateString(req.body?.meal_date);
		if (!mealDate) {
			return res.status(400).json({ message: "meal_date wajib diisi (YYYY-MM-DD)" });
		}

		const today = todayDateStringWib();
		if (mealDate > today) {
			return res.status(400).json({ message: "Tanggal makan tidak boleh di masa depan" });
		}

		const type = String(req.body?.type || "").trim().toLowerCase();
		if (!ALLOWED_TYPES.has(type)) {
			return res.status(400).json({ message: "Tipe tidak valid. Gunakan: half_day, full_day" });
		}

		const notes = String(req.body?.notes || "").trim().slice(0, 1000) || null;
		const amount = amountForType(type);

		const [result] = await safeCleanoxQuery(
			`
				INSERT INTO tr_worker_meal
					(worker_id, meal_date, type, amount, notes, status, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, 'menunggu_tf', NOW(), NOW())
			`,
			[workerId, mealDate, type, amount, notes]
		);

		const [rows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [
			result.insertId,
		]);
		const row = rows?.[0];
		const employeeMap = await getEmployeeMap([row.worker_id]);
		const emp = employeeMap.get(Number(row.worker_id)) || {};

		return res.status(201).json({
			message: "Pengajuan makan siang berhasil",
			record: mapRecord(row, emp),
		});
	} catch (err) {
		if (isDuplicateKeyError(err)) {
			return res.status(409).json({ message: "Pengajuan makan siang untuk tanggal ini sudah ada" });
		}
		console.error("[createMeal Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengajukan makan siang" });
	}
};

export const updateMeal = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [existingRows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [id]);
		const existing = existingRows?.[0];
		if (!existing) return res.status(404).json({ message: "Pengajuan tidak ditemukan" });
		if (existing.status !== "menunggu_tf") {
			return res.status(400).json({ message: "Hanya pengajuan menunggu TF yang bisa diubah" });
		}

		const today = todayDateStringWib();
		const mealDate = toISODateString(req.body?.meal_date) || toDateOnly(existing.meal_date);
		if (!mealDate) {
			return res.status(400).json({ message: "Format tanggal tidak valid" });
		}
		if (mealDate > today) {
			return res.status(400).json({ message: "Tanggal makan tidak boleh di masa depan" });
		}

		const type =
			req.body?.type != null ? String(req.body.type).trim().toLowerCase() : existing.type;
		if (!ALLOWED_TYPES.has(type)) {
			return res.status(400).json({ message: "Tipe tidak valid. Gunakan: half_day, full_day" });
		}

		const notes =
			req.body?.notes !== undefined
				? String(req.body.notes || "").trim().slice(0, 1000) || null
				: existing.notes;

		const amount = amountForType(type);

		await safeCleanoxQuery(
			`
				UPDATE tr_worker_meal
				SET meal_date = ?, type = ?, amount = ?, notes = ?, updated_at = NOW()
				WHERE id = ? AND status = 'menunggu_tf'
			`,
			[mealDate, type, amount, notes, id]
		);

		const [rows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [id]);
		const employeeMap = await getEmployeeMap([rows[0].worker_id]);
		const emp = employeeMap.get(Number(rows[0].worker_id)) || {};

		return res.json({
			message: "Pengajuan diperbarui",
			record: mapRecord(rows[0], emp),
		});
	} catch (err) {
		if (isDuplicateKeyError(err)) {
			return res.status(409).json({ message: "Pengajuan makan siang untuk tanggal ini sudah ada" });
		}
		console.error("[updateMeal Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal memperbarui pengajuan" });
	}
};

export const deleteMeal = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [result] = await safeCleanoxQuery(
			`DELETE FROM tr_worker_meal WHERE id = ? AND status = 'menunggu_tf'`,
			[id]
		);

		if (result.affectedRows === 0) {
			return res.status(404).json({ message: "Pengajuan tidak ditemukan atau sudah selesai" });
		}

		return res.json({ message: "Pengajuan dihapus" });
	} catch (err) {
		console.error("[deleteMeal Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal menghapus pengajuan" });
	}
};

export const getMealById = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [rows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [id]);
		const row = rows?.[0];
		if (!row) return res.status(404).json({ message: "Data makan siang tidak ditemukan" });

		const employeeMap = await getEmployeeMap([row.worker_id]);
		const emp = employeeMap.get(Number(row.worker_id)) || {};
		return res.json({ record: mapRecord(row, emp) });
	} catch (err) {
		console.error("[getMealById Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal mengambil detail makan siang" });
	}
};

export const completeMeal = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		if (!req.file?.filename) {
			return res.status(400).json({ message: "Bukti TF wajib diunggah" });
		}
		if (!CLEANOX_MEAL_DIR) {
			return res.status(500).json({ message: "CLEANOX_BASE_DIR belum dikonfigurasi" });
		}

		const [rows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [id]);
		const existing = rows?.[0];
		if (!existing) return res.status(404).json({ message: "Data makan siang tidak ditemukan" });
		if (existing.status !== "menunggu_tf") {
			return res.status(400).json({ message: "Hanya status menunggu TF yang bisa diselesaikan" });
		}

		const proof_file = req.file.filename;
		const proof_path = proofPathFromFilename(proof_file);
		const process_note = String(req.body?.process_note || "").trim().slice(0, 1000) || null;
		const processed_by = resolveProcessedById(req);
		const processed_by_name = resolveProcessedByName(req);

		await safeCleanoxQuery(
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
				WHERE id = ? AND status = 'menunggu_tf'
			`,
			[proof_file, proof_path, process_note, processed_by, processed_by_name, id]
		);

		const [updatedRows] = await safeCleanoxQuery(`SELECT * FROM tr_worker_meal WHERE id = ? LIMIT 1`, [id]);
		const employeeMap = await getEmployeeMap([updatedRows[0].worker_id]);
		const emp = employeeMap.get(Number(updatedRows[0].worker_id)) || {};

		return res.json({
			message: "Makan siang ditandai selesai",
			record: mapRecord(updatedRows[0], emp),
		});
	} catch (err) {
		console.error("[completeMeal Cleanox] Error:", err);
		return res.status(500).json({ message: err.message || "Gagal menyelesaikan makan siang" });
	}
};

export const serveMealProof = async (req, res) => {
	try {
		if (!CLEANOX_MEAL_DIR) {
			return res.status(500).json({ message: "CLEANOX_BASE_DIR belum dikonfigurasi" });
		}
		const safeFileName = path.basename(req.params.filename || "");
		if (!safeFileName) return res.status(400).json({ message: "Nama file tidak valid" });
		const fullPath = path.join(CLEANOX_MEAL_DIR, safeFileName);
		if (!fs.existsSync(fullPath)) {
			return res.status(404).json({ message: "File bukti tidak ditemukan" });
		}
		return res.sendFile(fullPath);
	} catch (err) {
		console.error("[serveMealProof Cleanox] Error:", err);
		return res.status(500).json({ message: "Gagal membuka file bukti" });
	}
};
