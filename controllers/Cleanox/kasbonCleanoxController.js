import fs from "fs";
import path from "path";
import { safeQuery, safeCleanoxQuery } from "../../db/pool.js";
import { CLEANOX_KASBON_DIR } from "../../middleware/upload.js";
import {
	getCleanoxProduksiEmployeeIds,
	getCleanoxProduksiRoleMap,
} from "../../utils/cleanoxProduksiEmployees.js";

const CLEANOX_COMPANY_ID = 3;
const ALLOWED_TYPES = new Set(["kasbon", "pinjaman"]);
const ALLOWED_STATUSES = new Set(["pengajuan", "proses", "disetujui", "ditolak"]);
const ALLOWED_PAYMENT_METHODS = new Set(["tunai", "potong_gaji", "transfer", "lainnya"]);

// Cutoff: tgl 26 bulan lalu s/d tgl 25 bulan ini.
// Jika hari ini > 25, aktifkan cutoff bulan depan.
function getDefaultCutoff() {
	const now = new Date();
	const CUTOFF_END_DAY = 25;
	let month = now.getMonth() + 1;
	let year = now.getFullYear();
	if (now.getDate() > CUTOFF_END_DAY) {
		month += 1;
		if (month > 12) {
			month = 1;
			year += 1;
		}
	}
	const pad = (n) => String(n).padStart(2, "0");
	const start = new Date(year, month - 2, 26);
	const end = new Date(year, month - 1, CUTOFF_END_DAY);
	const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return { start: fmt(start), end: fmt(end) };
}

function toPositiveInt(v) {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toActorName(value) {
	const actor = String(value || "").trim().slice(0, 255);
	return actor || null;
}

function resolveApprovedByName(req) {
	return (
		toActorName(req.body?.actor_name) ||
		toActorName(req.body?.approved_by) ||
		toActorName(req.session?.user?.employee?.full_name) ||
		toActorName(req.session?.user?.name) ||
		toActorName(req.session?.userName) ||
		toActorName(req.session?.user?.username) ||
		toActorName(req.session?.user?.employee_id) ||
		toActorName(req.session?.employeeId) ||
		"Admin"
	);
}

function resolveApprovedById(req) {
	const candidates = [
		req.body?.actor_id,
		req.session?.user?.employee?.employee_id,
		req.session?.user?.employeeId,
		req.session?.employeeId,
		req.session?.user?.id,
		req.session?.user?.user_id,
		req.session?.userId,
		req.session?.id,
	];
	for (const c of candidates) {
		const n = toPositiveInt(c);
		if (n) return n;
	}
	return 0;
}

function getCurrentUser(req) {
	return {
		id: resolveApprovedById(req),
		name: resolveApprovedByName(req),
	};
}

function buildProofUrl(filename) {
	if (!filename) return null;
	if (/^https?:\/\//i.test(filename)) return filename;
	if (String(filename).startsWith("/cleanox/kasbon/proofs/")) return filename;
	return `/cleanox/kasbon/proofs/${encodeURIComponent(path.basename(filename))}`;
}

function proofPathFromFilename(filename) {
	if (!filename) return null;
	return `/cleanox/kasbon/proofs/${path.basename(filename)}`;
}

function unlinkProof(filename) {
	if (!filename || !CLEANOX_KASBON_DIR) return;
	const safeName = path.basename(filename);
	const fullPath = path.join(CLEANOX_KASBON_DIR, safeName);
	fs.unlink(fullPath, () => {});
}

async function getEmployeeMap(workerIds) {
	const uniqueIds = [
		...new Set(workerIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)),
	];
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
			role: roleMap.get(Number(row.employee_id)) || null,
		});
	}
	return map;
}

async function assertCleanoxEmployee(employeeId) {
	const id = toPositiveInt(employeeId);
	if (!id) return null;

	const [roleRows] = await safeCleanoxQuery(
		"SELECT employee_id, role FROM mst_role WHERE employee_id = ? AND role = 'produksi' LIMIT 1",
		[id]
	);
	if (!roleRows?.length) return null;

	const [rows] = await safeQuery(
		`
			SELECT e.employee_id, e.employee_code, e.full_name
			FROM mst_employee e
			WHERE e.employee_id = ?
				AND e.company_id = ?
				AND e.is_deleted = 0
				AND e.exit_date IS NULL
			LIMIT 1
		`,
		[id, CLEANOX_COMPANY_ID]
	);
	if (!rows?.length) return null;

	return {
		employee_id: Number(rows[0].employee_id),
		employee_code: rows[0].employee_code || null,
		employee_name: rows[0].full_name || null,
		role: roleRows[0].role || null,
	};
}

function enrichRow(row, empMap, paymentMap, cutoffMap, cutoff) {
	const workerId = Number(row.worker_id);
	const emp = empMap.get(workerId) || {};
	const totalPaid =
		row.type === "pinjaman" && row.status === "disetujui"
			? paymentMap.get(Number(row.id)) ?? 0
			: row.type === "pinjaman"
				? paymentMap.get(Number(row.id)) ?? 0
				: null;
	const remaining =
		row.type === "pinjaman" && row.amount_approved != null
			? Number(row.amount_approved) - (paymentMap.get(Number(row.id)) ?? 0)
			: null;

	return {
		...row,
		employee_id: workerId,
		employee_name: emp.employee_name || null,
		employee_code: emp.employee_code || null,
		role: emp.role || emp.jabatan || null,
		proof_url: buildProofUrl(row.proof_file || row.proof_path),
		total_paid: row.type === "pinjaman" ? totalPaid : null,
		remaining: row.type === "pinjaman" ? remaining : null,
		cutoff_net: cutoffMap?.get(workerId) ?? 0,
		cutoff_period: cutoff || null,
	};
}

// ── GET /employee-options ──────────────────────────────────────────────────
export const getEmployeeOptions = async (req, res) => {
	try {
		const assignedIds = await getCleanoxProduksiEmployeeIds();
		const roleMap = await getCleanoxProduksiRoleMap();

		if (assignedIds.length === 0) {
			return res.json({ data: [] });
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

		const data = (employees || []).map((e) => ({
			employee_id: Number(e.employee_id),
			employee_code: e.employee_code || null,
			full_name: e.full_name || null,
			role: roleMap.get(Number(e.employee_id)) || null,
		}));

		res.json({ data });
	} catch (err) {
		console.error("[getEmployeeOptions Cleanox Kasbon]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── GET /employee-summary ───────────────────────────────────────────────────
export const getEmployeeSummary = async (req, res) => {
	try {
		const cutoff = getDefaultCutoff();
		const startDate = toISODateString(req.query.startDate) || cutoff.start;
		const endDate = toISODateString(req.query.endDate) || cutoff.end;

		const where = ["k.submission_date >= ?", "k.submission_date <= ?"];
		const params = [startDate, endDate];
		const whereSql = `WHERE ${where.join(" AND ")}`;

		const [summaryRows] = await safeCleanoxQuery(
			`
				SELECT
					k.worker_id,
					COUNT(CASE WHEN k.type = 'kasbon' THEN 1 END) AS kasbon_count,
					COALESCE(SUM(CASE WHEN k.type = 'kasbon' AND k.status = 'disetujui' THEN k.amount_approved ELSE 0 END), 0) AS kasbon_total,
					COUNT(CASE WHEN k.type = 'pinjaman' THEN 1 END) AS pinjaman_count,
					COALESCE(SUM(CASE WHEN k.type = 'pinjaman' AND k.status = 'disetujui' THEN k.amount_approved ELSE 0 END), 0) AS pinjaman_total
				FROM tr_worker_kasbon k
				${whereSql}
				GROUP BY k.worker_id
				ORDER BY k.worker_id ASC
			`,
			params
		);

		const empIds = (summaryRows || []).map((r) => Number(r.worker_id));
		const empMap = await getEmployeeMap(empIds);
		const paidMap = new Map();

		if (empIds.length) {
			const ph = empIds.map(() => "?").join(",");
			const [paidRows] = await safeCleanoxQuery(
				`
					SELECT k.worker_id, SUM(p.amount) AS total_paid
					FROM tr_worker_kasbon_payment p
					JOIN tr_worker_kasbon k ON k.id = p.kasbon_id
					WHERE k.status = 'disetujui'
						AND k.type = 'pinjaman'
						AND k.worker_id IN (${ph})
						AND k.submission_date >= ?
						AND k.submission_date <= ?
					GROUP BY k.worker_id
				`,
				[...empIds, startDate, endDate]
			);
			(paidRows || []).forEach((r) =>
				paidMap.set(Number(r.worker_id), Number(r.total_paid || 0))
			);
		}

		const data = (summaryRows || [])
			.map((r) => {
				const workerId = Number(r.worker_id);
				const emp = empMap.get(workerId) || {};
				const kasbonTotal = Number(r.kasbon_total || 0);
				const pinjamanTotal = Number(r.pinjaman_total || 0);
				const totalPaid = paidMap.get(workerId) || 0;
				return {
					employee_id: workerId,
					employee_name: emp.employee_name || `ID ${workerId}`,
					employee_code: emp.employee_code || null,
					role: emp.role || null,
					kasbon_count: Number(r.kasbon_count || 0),
					kasbon_total: kasbonTotal,
					pinjaman_count: Number(r.pinjaman_count || 0),
					pinjaman_total: pinjamanTotal,
					total_all: kasbonTotal + pinjamanTotal,
					total_paid: totalPaid,
					sisa: Math.max(0, pinjamanTotal - totalPaid),
				};
			})
			.sort((a, b) => String(a.employee_name).localeCompare(String(b.employee_name)));

		res.json({
			data,
			period: { startDate, endDate, cutoff },
		});
	} catch (err) {
		console.error("[getEmployeeSummary Cleanox Kasbon]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── GET / - list kasbon/pinjaman ───────────────────────────────────────────
export const getKasbons = async (req, res) => {
	try {
		const { type, status, startDate, endDate, search, page, limit, employeeId } = req.query;
		const pg = toPositiveInt(page) ?? 1;
		const lm = Math.min(toPositiveInt(limit) ?? 25, 9999);
		const offset = (pg - 1) * lm;

		const where = [];
		const params = [];

		if (type && ALLOWED_TYPES.has(type)) {
			where.push("k.type = ?");
			params.push(type);
		}
		if (status && ALLOWED_STATUSES.has(status)) {
			where.push("k.status = ?");
			params.push(status);
		}
		if (toISODateString(startDate)) {
			where.push("k.submission_date >= ?");
			params.push(startDate);
		}
		if (toISODateString(endDate)) {
			where.push("k.submission_date <= ?");
			params.push(endDate);
		}
		if (employeeId) {
			where.push("k.worker_id = ?");
			params.push(Number(employeeId));
		}

		if (search?.trim()) {
			const like = `%${search.trim()}%`;
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
			const matchedIds = (empRows || []).map((r) => Number(r.employee_id)).filter(Boolean);
			if (matchedIds.length > 0) {
				where.push(
					`(k.purpose LIKE ? OR k.notes LIKE ? OR k.worker_id IN (${matchedIds.map(() => "?").join(",")}))`
				);
				params.push(like, like, ...matchedIds);
			} else {
				where.push("(k.purpose LIKE ? OR k.notes LIKE ?)");
				params.push(like, like);
			}
		}

		const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

		const [statsRows] = await safeCleanoxQuery(
			`
				SELECT
					COUNT(*) AS total,
					COUNT(CASE WHEN k.type = 'kasbon' THEN 1 END) AS totalKasbon,
					COUNT(CASE WHEN k.type = 'pinjaman' THEN 1 END) AS totalPinjaman,
					COUNT(CASE WHEN k.status IN ('pengajuan', 'proses') THEN 1 END) AS pending,
					COUNT(CASE WHEN k.status = 'disetujui' THEN 1 END) AS approved,
					COALESCE(SUM(CASE WHEN k.status = 'disetujui' THEN k.amount_approved ELSE 0 END), 0) AS approvedAmount
				FROM tr_worker_kasbon k
				${whereSql}
			`,
			params
		);
		const statsRow = statsRows?.[0] || {};
		const total = Number(statsRow.total || 0);

		const [rows] = await safeCleanoxQuery(
			`
				SELECT
					k.id, k.worker_id, k.type, k.submission_date,
					k.amount_requested, k.amount_approved, k.purpose, k.notes,
					k.proof_file, k.proof_path, k.status,
					k.process_note, k.process_by, k.process_by_name, k.process_at,
					k.approved_note, k.approved_by, k.approved_by_name, k.approved_at,
					k.rejection_note, k.created_at, k.updated_at
				FROM tr_worker_kasbon k
				${whereSql}
				ORDER BY k.submission_date DESC, k.id DESC
				LIMIT ? OFFSET ?
			`,
			[...params, lm, offset]
		);

		const paymentMap = new Map();
		const pinjamanIds = (rows || [])
			.filter((r) => r.type === "pinjaman" && r.status === "disetujui")
			.map((r) => Number(r.id));
		if (pinjamanIds.length) {
			const ph = pinjamanIds.map(() => "?").join(",");
			const [payments] = await safeCleanoxQuery(
				`
					SELECT kasbon_id, SUM(amount) AS total_paid
					FROM tr_worker_kasbon_payment
					WHERE kasbon_id IN (${ph})
					GROUP BY kasbon_id
				`,
				pinjamanIds
			);
			(payments || []).forEach((p) =>
				paymentMap.set(Number(p.kasbon_id), Number(p.total_paid || 0))
			);
		}

		const cutoff = getDefaultCutoff();
		const allEmpIds = [...new Set((rows || []).map((r) => Number(r.worker_id)))];
		const empMap = await getEmployeeMap(allEmpIds);
		const cutoffMap = new Map();

		if (allEmpIds.length) {
			const ph = allEmpIds.map(() => "?").join(",");
			const [approvedInCutoff] = await safeCleanoxQuery(
				`
					SELECT worker_id, SUM(amount_approved) AS total_approved
					FROM tr_worker_kasbon
					WHERE status = 'disetujui'
						AND submission_date BETWEEN ? AND ?
						AND worker_id IN (${ph})
					GROUP BY worker_id
				`,
				[cutoff.start, cutoff.end, ...allEmpIds]
			);
			const [paidInCutoff] = await safeCleanoxQuery(
				`
					SELECT k.worker_id, SUM(p.amount) AS total_paid
					FROM tr_worker_kasbon_payment p
					JOIN tr_worker_kasbon k ON k.id = p.kasbon_id
					WHERE k.status = 'disetujui'
						AND k.submission_date BETWEEN ? AND ?
						AND k.worker_id IN (${ph})
					GROUP BY k.worker_id
				`,
				[cutoff.start, cutoff.end, ...allEmpIds]
			);

			const approvedM = new Map(
				(approvedInCutoff || []).map((r) => [Number(r.worker_id), Number(r.total_approved || 0)])
			);
			const paidM = new Map(
				(paidInCutoff || []).map((r) => [Number(r.worker_id), Number(r.total_paid || 0)])
			);
			for (const empId of allEmpIds) {
				cutoffMap.set(empId, (approvedM.get(empId) || 0) - (paidM.get(empId) || 0));
			}
		}

		const data = (rows || []).map((r) => enrichRow(r, empMap, paymentMap, cutoffMap, cutoff));

		res.json({
			data,
			pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) || 1 },
			stats: {
				totalKasbon: Number(statsRow.totalKasbon || 0),
				totalPinjaman: Number(statsRow.totalPinjaman || 0),
				pending: Number(statsRow.pending || 0),
				approved: Number(statsRow.approved || 0),
				approvedAmount: Number(statsRow.approvedAmount || 0),
			},
		});
	} catch (err) {
		console.error("[getKasbons Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── GET /proofs/:filename ──────────────────────────────────────────────────
export const serveProof = async (req, res) => {
	try {
		if (!CLEANOX_KASBON_DIR) {
			return res.status(500).json({ message: "CLEANOX_BASE_DIR belum dikonfigurasi" });
		}

		const kasbonDir = CLEANOX_KASBON_DIR;
		const safeFileName = path.basename(String(req.params.filename || ""));
		if (!safeFileName) {
			return res.status(400).json({ message: "Nama file tidak valid" });
		}

		const fullPath = path.join(kasbonDir, safeFileName);
		const resolvedDir = path.resolve(kasbonDir);
		const resolvedFile = path.resolve(fullPath);
		if (!resolvedFile.startsWith(resolvedDir + path.sep) || !fs.existsSync(resolvedFile)) {
			return res.status(404).json({ message: "File bukti tidak ditemukan" });
		}

		res.setHeader("Cache-Control", "private, max-age=300");
		return res.sendFile(resolvedFile);
	} catch (err) {
		console.error("[serveProof Cleanox Kasbon]:", err);
		return res.status(500).json({ message: "Gagal membuka file bukti" });
	}
};

// ── GET /:id - detail + payments ───────────────────────────────────────────
export const getKasbonDetail = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [kasbonRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_kasbon WHERE id = ?`,
			[id]
		);
		const kasbon = kasbonRows?.[0];
		if (!kasbon) return res.status(404).json({ message: "Data tidak ditemukan" });

		const [payments] = await safeCleanoxQuery(
			`
				SELECT id, payment_date, amount, payment_method, notes, recorded_by, recorded_by_name, created_at
				FROM tr_worker_kasbon_payment
				WHERE kasbon_id = ?
				ORDER BY payment_date ASC, id ASC
			`,
			[id]
		);

		const totalPaid = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
		const remaining =
			kasbon.type === "pinjaman" && kasbon.amount_approved != null
				? Number(kasbon.amount_approved) - totalPaid
				: null;

		const empMap = await getEmployeeMap([kasbon.worker_id]);
		const emp = empMap.get(Number(kasbon.worker_id)) || {};

		res.json({
			data: {
				...kasbon,
				employee_id: Number(kasbon.worker_id),
				employee_name: emp.employee_name || null,
				employee_code: emp.employee_code || null,
				role: emp.role || emp.jabatan || null,
				proof_url: buildProofUrl(kasbon.proof_file || kasbon.proof_path),
				payments: payments || [],
				total_paid: totalPaid,
				remaining,
			},
		});
	} catch (err) {
		console.error("[getKasbonDetail Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── POST / - create (admin) ────────────────────────────────────────────────
export const createKasbon = async (req, res) => {
	try {
		const { employee_id, type, submission_date, amount_requested, purpose, notes } = req.body;

		if (!employee_id || !type || !submission_date || !amount_requested || !purpose) {
			return res.status(400).json({ message: "Field wajib tidak lengkap" });
		}
		if (!ALLOWED_TYPES.has(type)) {
			return res.status(400).json({ message: "Tipe tidak valid" });
		}
		if (!toISODateString(submission_date)) {
			return res.status(400).json({ message: "Format tanggal tidak valid" });
		}

		const employee = await assertCleanoxEmployee(employee_id);
		if (!employee) {
			return res.status(400).json({ message: "Karyawan Cleanox tidak ditemukan" });
		}

		const proof_file = req.file?.filename || null;
		const proof_path = proofPathFromFilename(proof_file);

		const [result] = await safeCleanoxQuery(
			`
				INSERT INTO tr_worker_kasbon
					(worker_id, type, submission_date, amount_requested, purpose, notes, proof_file, proof_path, status)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pengajuan')
			`,
			[
				employee.employee_id,
				type,
				submission_date,
				Number(amount_requested),
				purpose,
				notes || null,
				proof_file,
				proof_path,
			]
		);

		res.status(201).json({ message: "Pengajuan berhasil dibuat", id: result.insertId });
	} catch (err) {
		console.error("[createKasbon Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── PUT /:id - update basic fields ─────────────────────────────────────────
export const updateKasbon = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const { employee_id, type, submission_date, amount_requested, purpose, notes, remove_proof } =
			req.body;

		const [existingRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_kasbon WHERE id = ?`,
			[id]
		);
		const existing = existingRows?.[0];
		if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

		let workerId = existing.worker_id;
		if (employee_id) {
			const employee = await assertCleanoxEmployee(employee_id);
			if (!employee) {
				return res.status(400).json({ message: "Karyawan Cleanox tidak ditemukan" });
			}
			workerId = employee.employee_id;
		}

		if (type && !ALLOWED_TYPES.has(type)) {
			return res.status(400).json({ message: "Tipe tidak valid" });
		}
		if (submission_date && !toISODateString(submission_date)) {
			return res.status(400).json({ message: "Format tanggal tidak valid" });
		}

		let proof_file = existing.proof_file;
		let proof_path = existing.proof_path;

		if (req.file) {
			unlinkProof(existing.proof_file || existing.proof_path);
			proof_file = req.file.filename;
			proof_path = proofPathFromFilename(proof_file);
		} else if (remove_proof === "true" || remove_proof === true) {
			unlinkProof(existing.proof_file || existing.proof_path);
			proof_file = null;
			proof_path = null;
		}

		await safeCleanoxQuery(
			`
				UPDATE tr_worker_kasbon
				SET worker_id=?, type=?, submission_date=?,
						amount_requested=?, purpose=?, notes=?, proof_file=?, proof_path=?
				WHERE id=?
			`,
			[
				workerId,
				type || existing.type,
				submission_date || existing.submission_date,
				Number(amount_requested ?? existing.amount_requested),
				purpose || existing.purpose,
				notes !== undefined ? notes || null : existing.notes,
				proof_file,
				proof_path,
				id,
			]
		);

		res.json({ message: "Data berhasil diperbarui" });
	} catch (err) {
		console.error("[updateKasbon Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── PUT /:id/status ────────────────────────────────────────────────────────
export const updateKasbonStatus = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const { status, process_note, approved_note, rejection_note, amount_approved } = req.body;
		const admin = getCurrentUser(req);

		if (!["proses", "disetujui", "ditolak"].includes(status)) {
			return res.status(400).json({ message: "Status tidak valid" });
		}

		const [existingRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_kasbon WHERE id = ?`,
			[id]
		);
		const existing = existingRows?.[0];
		if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

		const now = new Date().toISOString().slice(0, 19).replace("T", " ");

		if (status === "proses") {
			await safeCleanoxQuery(
				`
					UPDATE tr_worker_kasbon
					SET status='proses', process_note=?, process_by=?, process_by_name=?, process_at=?
					WHERE id=?
				`,
				[process_note || null, admin.id || null, admin.name, now, id]
			);
		} else if (status === "disetujui") {
			if (amount_approved == null || amount_approved === "") {
				return res.status(400).json({ message: "Jumlah yang disetujui wajib diisi" });
			}
			await safeCleanoxQuery(
				`
					UPDATE tr_worker_kasbon
					SET status='disetujui', amount_approved=?, approved_note=?,
							approved_by=?, approved_by_name=?, approved_at=?
					WHERE id=?
				`,
				[
					Number(amount_approved),
					approved_note || null,
					admin.id || null,
					admin.name,
					now,
					id,
				]
			);
		} else if (status === "ditolak") {
			await safeCleanoxQuery(
				`UPDATE tr_worker_kasbon SET status='ditolak', rejection_note=? WHERE id=?`,
				[rejection_note || null, id]
			);
		}

		res.json({ message: `Status berhasil diubah ke ${status}` });
	} catch (err) {
		console.error("[updateKasbonStatus Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── DELETE /:id ────────────────────────────────────────────────────────────
export const deleteKasbon = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const [existingRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_kasbon WHERE id = ?`,
			[id]
		);
		const existing = existingRows?.[0];
		if (!existing) return res.status(404).json({ message: "Data tidak ditemukan" });

		unlinkProof(existing.proof_file || existing.proof_path);
		await safeCleanoxQuery(`DELETE FROM tr_worker_kasbon WHERE id = ?`, [id]);
		res.json({ message: "Data berhasil dihapus" });
	} catch (err) {
		console.error("[deleteKasbon Cleanox]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── POST /:id/payment ──────────────────────────────────────────────────────
export const addPayment = async (req, res) => {
	try {
		const kasbon_id = toPositiveInt(req.params.id);
		if (!kasbon_id) return res.status(400).json({ message: "ID tidak valid" });

		const { payment_date, amount, payment_method, notes } = req.body;
		const admin = getCurrentUser(req);

		if (!payment_date || !amount || !payment_method) {
			return res.status(400).json({ message: "Field wajib tidak lengkap" });
		}
		if (!toISODateString(payment_date)) {
			return res.status(400).json({ message: "Format tanggal tidak valid" });
		}
		if (!ALLOWED_PAYMENT_METHODS.has(payment_method)) {
			return res.status(400).json({ message: "Metode pembayaran tidak valid" });
		}

		const [kasbonRows] = await safeCleanoxQuery(
			`SELECT * FROM tr_worker_kasbon WHERE id = ?`,
			[kasbon_id]
		);
		const kasbon = kasbonRows?.[0];
		if (!kasbon) return res.status(404).json({ message: "Data kasbon tidak ditemukan" });
		if (kasbon.type !== "pinjaman") {
			return res.status(400).json({ message: "Pembayaran hanya untuk tipe pinjaman" });
		}
		if (kasbon.status !== "disetujui") {
			return res.status(400).json({ message: "Pinjaman belum disetujui" });
		}

		await safeCleanoxQuery(
			`
				INSERT INTO tr_worker_kasbon_payment
					(kasbon_id, payment_date, amount, payment_method, notes, recorded_by, recorded_by_name)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`,
			[
				kasbon_id,
				payment_date,
				Number(amount),
				payment_method,
				notes || null,
				admin.id || null,
				admin.name,
			]
		);

		res.status(201).json({ message: "Pembayaran berhasil dicatat" });
	} catch (err) {
		console.error("[addPayment Cleanox Kasbon]:", err);
		res.status(500).json({ message: err.message });
	}
};

// ── DELETE /:id/payment/:paymentId ─────────────────────────────────────────
export const deletePayment = async (req, res) => {
	try {
		const kasbon_id = toPositiveInt(req.params.id);
		const payment_id = toPositiveInt(req.params.paymentId);
		if (!kasbon_id || !payment_id) {
			return res.status(400).json({ message: "ID tidak valid" });
		}

		const [paymentRows] = await safeCleanoxQuery(
			`SELECT id FROM tr_worker_kasbon_payment WHERE id = ? AND kasbon_id = ?`,
			[payment_id, kasbon_id]
		);
		if (!paymentRows?.length) {
			return res.status(404).json({ message: "Data pembayaran tidak ditemukan" });
		}

		await safeCleanoxQuery(`DELETE FROM tr_worker_kasbon_payment WHERE id = ?`, [payment_id]);
		res.json({ message: "Pembayaran berhasil dihapus" });
	} catch (err) {
		console.error("[deletePayment Cleanox Kasbon]:", err);
		res.status(500).json({ message: err.message });
	}
};
