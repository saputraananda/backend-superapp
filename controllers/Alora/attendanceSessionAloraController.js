import fs from "fs";
import path from "path";
import multer from "multer";
import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";

const ALLOWED_STATUSES = new Set([
	"in_progress",
	"Pending_Supervisor",
	"Pending_HRD",
	"Rejected_Supervisor",
	"Rejected_HRD",
	"disetujui",
]);
const ALLOWED_SESSION_TYPES = new Set(["lembur", "earned_replace_off"]);

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function toDateInput(date) {
	const d = new Date(date);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDefaultCutoffRange(now = new Date()) {
	let cutoffMonth = now.getMonth() + 1;
	let cutoffYear = now.getFullYear();
	if (now.getDate() > 25) {
		cutoffMonth += 1;
		if (cutoffMonth > 12) {
			cutoffMonth = 1;
			cutoffYear += 1;
		}
	}
	const start = new Date(cutoffYear, cutoffMonth - 2, 26);
	const end = new Date(cutoffYear, cutoffMonth - 1, 25);
	return { startDate: toDateInput(start), endDate: toDateInput(end) };
}

function isSupervisorUser(employee) {
	if (!employee) return false;
	const level = Number(employee.job_level_id);
	return !Number.isNaN(level) && level <= 3;
}

async function getEmployeeDetails(employeeId) {
	const [rows] = await safeQuery(
		`SELECT e.*, jl.job_level_name, p.position_name, d.department_name
     FROM mst_employee e
     LEFT JOIN mst_job_level jl ON e.job_level_id = jl.job_level_id
     LEFT JOIN mst_position p ON e.position_id = p.position_id
     LEFT JOIN mst_department d ON e.department_id = d.department_id
     WHERE e.employee_id = ? AND e.is_deleted = 0 LIMIT 1`,
		[employeeId]
	);
	return rows[0] || null;
}

async function getEmployeeMap(employeeIds) {
	const uniqueIds = [...new Set(employeeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
	if (uniqueIds.length === 0) return new Map();
	const placeholders = uniqueIds.map(() => "?").join(",");
	const [rows] = await safeQuery(
		`SELECT e.employee_id, e.full_name, p.position_name, j.job_level_name, d.department_name, e.department_id
     FROM mst_employee e
     LEFT JOIN mst_position p ON p.position_id = e.position_id
     LEFT JOIN mst_job_level j ON j.job_level_id = e.job_level_id
     LEFT JOIN mst_department d ON d.department_id = e.department_id
     WHERE e.is_deleted = 0 AND e.employee_id IN (${placeholders})`,
		uniqueIds
	);
	const map = new Map();
	for (const row of rows) {
		map.set(Number(row.employee_id), {
			employee_name: row.full_name || null,
			jabatan: row.job_level_name || row.position_name || "-",
			department_name: row.department_name || "-",
			department_id: row.department_id,
		});
	}
	return map;
}

function formatTimeFromDate(value) {
	if (!value) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Asia/Jakarta",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).formatToParts(d);
	return `${parts.find((p) => p.type === "hour")?.value || "00"}:${parts.find((p) => p.type === "minute")?.value || "00"}`;
}

async function getOvertimeBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_overtime_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

async function getReplaceOffBalance(employeeId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT balance_after FROM tr_replace_off_ledger WHERE employee_id = ? ORDER BY id DESC LIMIT 1`,
		[employeeId]
	);
	return rows[0]?.balance_after != null ? Number(rows[0].balance_after) : 0;
}

async function appendOvertimeLedger({ employeeId, sessionId, hours, note }) {
	const current = await getOvertimeBalance(employeeId);
	const balanceAfter = Math.round((current + Math.abs(Number(hours))) * 100) / 100;
	await safeAloraMobileQuery(
		`INSERT INTO tr_overtime_ledger (employee_id, session_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, 'earned', ?, ?, ?)`,
		[employeeId, sessionId, Math.abs(Number(hours)), balanceAfter, note]
	);
	return balanceAfter;
}

async function appendReplaceOffLedger({ employeeId, sessionId, hours, note }) {
	const current = await getReplaceOffBalance(employeeId);
	const balanceAfter = Math.round((current + Math.abs(Number(hours))) * 100) / 100;
	await safeAloraMobileQuery(
		`INSERT INTO tr_replace_off_ledger (employee_id, session_id, mutation_type, hours, balance_after, note)
     VALUES (?, ?, 'earned', ?, ?, ?)`,
		[employeeId, sessionId, Math.abs(Number(hours)), balanceAfter, note]
	);
	return balanceAfter;
}

async function hasBodAttachment(sessionId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT id FROM tr_approval_attachments
     WHERE entity_type = 'attendance_session' AND entity_id = ? AND attachment_role = 'bod_proof' LIMIT 1`,
		[sessionId]
	);
	return rows.length > 0;
}

function getBodUploadDir() {
	const base = process.env.ALORA_MOBILE_ATTENDANCE_DIR || path.join(process.cwd(), "uploads", "alora-bod");
	if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
	return base;
}

const bodUpload = multer({
	storage: multer.diskStorage({
		destination: (_req, _file, cb) => cb(null, getBodUploadDir()),
		filename: (_req, file, cb) => {
			const ext = path.extname(file.originalname || ".jpg") || ".jpg";
			cb(null, `bod_${Date.now()}${ext}`);
		},
	}),
	limits: { fileSize: 5 * 1024 * 1024 },
});

export const uploadBodMiddleware = bodUpload.single("bod_proof");

export const getSessionList = async (req, res) => {
	try {
		if (!req.session?.employeeId) {
			return res.status(400).json({ message: "Sesi karyawan tidak valid" });
		}

		const defaults = getDefaultCutoffRange();
		const startDate = toISODateString(req.query.startDate) || defaults.startDate;
		const endDate = toISODateString(req.query.endDate) || defaults.endDate;
		const statusFilter = String(req.query.status || "Pending_Supervisor").trim();
		const sessionTypeFilter = String(req.query.sessionType || "").trim();

		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;

		const where = ["s.work_date >= ?", "s.work_date <= ?", "s.status <> 'in_progress'"];
		const params = [startDate, endDate];

		if (statusFilter && ALLOWED_STATUSES.has(statusFilter)) {
			where.push("s.status = ?");
			params.push(statusFilter);
		}
		if (sessionTypeFilter && ALLOWED_SESSION_TYPES.has(sessionTypeFilter)) {
			where.push("s.session_type = ?");
			params.push(sessionTypeFilter);
		}

		const whereSql = where.join(" AND ");
		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_attendance_sessions s WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);

		const [rows] = await safeAloraMobileQuery(
			`SELECT s.* FROM tr_attendance_sessions s
       WHERE ${whereSql}
       ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);

		const employeeMap = await getEmployeeMap(rows.map((r) => r.employee_id));
		const records = rows.map((row) => {
			const emp = employeeMap.get(Number(row.employee_id)) || {};
			let todoItems = row.todo_items;
			if (typeof todoItems === "string") {
				try { todoItems = JSON.parse(todoItems); } catch { todoItems = []; }
			}
			return {
				...row,
				work_date: toDateInput(row.work_date),
				start_time: formatTimeFromDate(row.clock_in),
				end_time: formatTimeFromDate(row.clock_out),
				duration_hours: row.duration_hours != null ? Number(row.duration_hours) : null,
				todo_items: todoItems,
				employee_name: emp.employee_name || `ID ${row.employee_id}`,
				jabatan: emp.jabatan || "-",
				department_name: emp.department_name || "-",
			};
		});

		return res.json({
			records,
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
			period: { startDate, endDate },
		});
	} catch (err) {
		console.error("[alora getSessionList]", err);
		return res.status(500).json({ message: "Gagal mengambil data sesi absensi" });
	}
};

export const uploadBodAttachment = async (req, res) => {
	const uploadedAbs = req.file?.path || null;
	const cleanupNew = () => {
		if (uploadedAbs && fs.existsSync(uploadedAbs)) {
			try { fs.unlinkSync(uploadedAbs); } catch (_) { /* ignore */ }
		}
	};

	try {
		const id = toPositiveInt(req.params.id);
		if (!id) {
			cleanupNew();
			return res.status(400).json({ message: "ID tidak valid" });
		}
		if (!req.file) return res.status(422).json({ message: "File bukti BOD wajib dilampirkan" });

		const currentEmpId = req.session?.employeeId;
		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_attendance_sessions WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) {
			cleanupNew();
			return res.status(404).json({ message: "Sesi tidak ditemukan" });
		}
		if (item.session_type !== "earned_replace_off") {
			cleanupNew();
			return res.status(400).json({ message: "Bukti BOD hanya untuk Earned Replace Off" });
		}

		const [oldRows] = await safeAloraMobileQuery(
			`SELECT id, file_path FROM tr_approval_attachments
       WHERE entity_type = 'attendance_session' AND entity_id = ? AND attachment_role = 'bod_proof'`,
			[id]
		);

		const filePath = `/alora/attendance-sessions/bod/${req.file.filename}`;
		await safeAloraMobileQuery(
			`INSERT INTO tr_approval_attachments (entity_type, entity_id, attachment_role, file_path, uploaded_by)
       VALUES ('attendance_session', ?, 'bod_proof', ?, ?)`,
			[id, filePath, currentEmpId]
		);

		// Hapus file + row lama setelah upload baru sukses
		for (const old of oldRows) {
			await safeAloraMobileQuery(`DELETE FROM tr_approval_attachments WHERE id = ?`, [old.id]);
			const oldName = path.basename(String(old.file_path || ""));
			if (oldName) {
				const oldAbs = path.join(getBodUploadDir(), oldName);
				if (fs.existsSync(oldAbs)) {
					try { fs.unlinkSync(oldAbs); } catch (_) { /* ignore */ }
				}
			}
		}

		return res.json({ message: "Bukti BOD berhasil diunggah", file_path: filePath });
	} catch (err) {
		cleanupNew();
		console.error("[alora uploadBodAttachment]", err);
		return res.status(500).json({ message: "Gagal mengunggah bukti BOD" });
	}
};

export const approveSupervisor = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });

		const currentEmpId = req.session?.employeeId;
		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat memberikan persetujuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_attendance_sessions WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Sesi tidak ditemukan" });
		if (item.status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status sesi tidak valid untuk persetujuan supervisor" });
		}
		if (Number(currentEmp.department_id) !== Number(item.department_id)) {
			return res.status(403).json({ message: "Anda hanya dapat menyetujui sesi dari departemen Anda sendiri" });
		}

		if (item.session_type === "earned_replace_off") {
			const hasBod = await hasBodAttachment(id);
			if (!hasBod) {
				return res.status(400).json({ message: "Upload bukti izin BOD wajib sebelum menyetujui Earned RO" });
			}
		}

		await safeAloraMobileQuery(
			`UPDATE tr_attendance_sessions SET
        status = 'disetujui',
        supervisor_id = ?,
        supervisor_approved_at = NOW(),
        supervisor_rejection_reason = NULL,
        approved_by = ?,
        approved_by_name = ?,
        approved_at = NOW(),
        updated_at = NOW()
       WHERE id = ?`,
			[currentEmpId, currentEmpId, currentEmp.full_name || null, id]
		);

		const hours = Number(item.duration_hours) || 0;
		if (item.session_type === "lembur" && hours > 0) {
			await appendOvertimeLedger({
				employeeId: item.employee_id,
				sessionId: id,
				hours,
				note: `Lembur disetujui SPV ${toDateInput(item.work_date)}`,
			});
		}
		if (item.session_type === "earned_replace_off" && hours > 0) {
			await appendReplaceOffLedger({
				employeeId: item.employee_id,
				sessionId: id,
				hours,
				note: `Earned RO disetujui SPV ${toDateInput(item.work_date)}`,
			});
		}

		return res.json({ message: "Sesi berhasil disetujui." });
	} catch (err) {
		console.error("[alora session approveSupervisor]", err);
		return res.status(500).json({ message: "Gagal melakukan approval supervisor" });
	}
};

export const rejectSupervisor = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		const reason = String(req.body?.reason || "").trim().slice(0, 1000);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });
		if (!reason) return res.status(400).json({ message: "Alasan penolakan wajib diisi" });

		const currentEmpId = req.session?.employeeId;
		const currentEmp = await getEmployeeDetails(currentEmpId);
		if (!isSupervisorUser(currentEmp)) {
			return res.status(403).json({ message: "Hanya supervisor yang dapat menolak pengajuan" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_attendance_sessions WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Sesi tidak ditemukan" });
		if (item.status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status sesi tidak valid untuk ditolak" });
		}
		if (Number(currentEmp.department_id) !== Number(item.department_id)) {
			return res.status(403).json({ message: "Anda hanya dapat menolak sesi dari departemen Anda sendiri" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_attendance_sessions SET
        status = 'Rejected_Supervisor',
        supervisor_id = ?,
        supervisor_rejection_reason = ?,
        updated_at = NOW()
       WHERE id = ?`,
			[currentEmpId, reason, id]
		);

		return res.json({ message: "Sesi berhasil ditolak." });
	} catch (err) {
		console.error("[alora session rejectSupervisor]", err);
		return res.status(500).json({ message: "Gagal menolak sesi" });
	}
};
