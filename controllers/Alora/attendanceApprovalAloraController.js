import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";
import { applyWodLedgerOnApprove } from "../../utils/attendanceApprovalService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOD_DIR = process.env.ALORA_MOBILE_ATTENDANCE_DIR || path.join(__dirname, "../../uploads/alora-bod");

if (!fs.existsSync(BOD_DIR)) fs.mkdirSync(BOD_DIR, { recursive: true });

const upload = multer({
	storage: multer.diskStorage({
		destination: (_req, _file, cb) => cb(null, BOD_DIR),
		filename: (_req, file, cb) => {
			const ext = path.extname(file.originalname) || ".jpg";
			cb(null, `attendance_bod_${Date.now()}${ext}`);
		},
	}),
	limits: { fileSize: 5 * 1024 * 1024 },
});

export const bodUploadMiddleware = upload.single("bod_file");

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
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

async function hasBodAttachment(attendanceId) {
	const [rows] = await safeAloraMobileQuery(
		`SELECT id FROM tr_approval_attachments
     WHERE entity_type = 'attendance' AND entity_id = ? AND attachment_role = 'bod_proof' LIMIT 1`,
		[attendanceId]
	);
	return rows.length > 0;
}

function formatModeLabel(row) {
	const mode = row.attendance_mode || "regular";
	const ctx = row.punch_location_context_in || "remote";
	if (mode === "wfa") return "WFA";
	if (mode === "wod") return ctx === "office" ? "WOD Office" : "WOD Remote";
	return "Harian";
}

export const getPendingApprovals = async (req, res) => {
	try {
		const modeFilter = String(req.query.mode || "").trim();
		const statusFilter = String(req.query.status || "Pending_Supervisor").trim();
		const page = Math.max(1, toPositiveInt(req.query.page) || 1);
		const limit = Math.min(200, Math.max(1, toPositiveInt(req.query.limit) || 50));
		const offset = (page - 1) * limit;

		const where = ["a.approval_status = ?", "a.attendance_mode IN ('wfa', 'wod')", "a.clock_out IS NOT NULL"];
		const params = [statusFilter];
		if (modeFilter === "wfa" || modeFilter === "wod") {
			where.push("a.attendance_mode = ?");
			params.push(modeFilter);
		}

		const whereSql = where.join(" AND ");
		const [countRows] = await safeAloraMobileQuery(
			`SELECT COUNT(*) AS total FROM tr_worker_attendance a WHERE ${whereSql}`,
			params
		);
		const total = Number(countRows?.[0]?.total || 0);

		const [rows] = await safeAloraMobileQuery(
			`SELECT a.* FROM tr_worker_attendance a
       WHERE ${whereSql}
       ORDER BY a.attendance_date DESC, a.clock_out DESC
       LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);

		const employeeMap = await getEmployeeMap(rows.map((r) => r.employee_id));
		const records = rows.map((row) => {
			const emp = employeeMap.get(Number(row.employee_id)) || {};
			return {
				...row,
				employee_name: emp.employee_name || `ID ${row.employee_id}`,
				jabatan: emp.jabatan || "-",
				department_name: emp.department_name || "-",
				mode_label: formatModeLabel(row),
				location_label: row.punch_location_context_in === "office" ? "Office" : "Remote",
			};
		});

		return res.json({
			records,
			pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
		});
	} catch (err) {
		console.error("[alora getPendingApprovals]", err);
		return res.status(500).json({ message: "Gagal mengambil approval absensi" });
	}
};

export const uploadBodAttachment = async (req, res) => {
	try {
		const id = toPositiveInt(req.params.id);
		if (!id) return res.status(400).json({ message: "ID tidak valid" });
		if (!req.file) return res.status(422).json({ message: "File bukti BOD wajib dilampirkan" });

		const currentEmpId = req.session?.employeeId;
		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_attendance WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Absensi tidak ditemukan" });
		if (!["wfa", "wod"].includes(item.attendance_mode)) {
			return res.status(400).json({ message: "Bukti BOD hanya untuk WFA/WOD" });
		}

		const filePath = `/alora/attendance-sessions/bod/${req.file.filename}`;
		await safeAloraMobileQuery(
			`INSERT INTO tr_approval_attachments (entity_type, entity_id, attachment_role, file_path, uploaded_by)
       VALUES ('attendance', ?, 'bod_proof', ?, ?)`,
			[id, filePath, currentEmpId]
		);

		return res.json({ message: "Bukti BOD berhasil diunggah", file_path: filePath });
	} catch (err) {
		console.error("[alora attendance uploadBod]", err);
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

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_attendance WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Absensi tidak ditemukan" });
		if (item.approval_status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status absensi tidak valid untuk persetujuan supervisor" });
		}
		if (!["wfa", "wod"].includes(item.attendance_mode)) {
			return res.status(400).json({ message: "Hanya WFA/WOD yang memerlukan approval" });
		}

		const empInfo = await getEmployeeMap([item.employee_id]);
		const empDept = empInfo.get(Number(item.employee_id))?.department_id;
		if (Number(currentEmp.department_id) !== Number(empDept)) {
			return res.status(403).json({ message: "Anda hanya dapat menyetujui absensi dari departemen Anda sendiri" });
		}

		const hasBod = await hasBodAttachment(id);
		if (!hasBod) {
			return res.status(400).json({ message: "Upload bukti izin BOD wajib sebelum menyetujui WFA/WOD" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_attendance SET
        approval_status = 'disetujui',
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

		if (item.attendance_mode === "wod") {
			await applyWodLedgerOnApprove(item);
		}

		return res.json({ message: "Absensi berhasil disetujui." });
	} catch (err) {
		console.error("[alora attendance approveSupervisor]", err);
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
			return res.status(403).json({ message: "Hanya supervisor yang dapat menolak absensi" });
		}

		const [rows] = await safeAloraMobileQuery(`SELECT * FROM tr_worker_attendance WHERE id = ?`, [id]);
		const item = rows[0];
		if (!item) return res.status(404).json({ message: "Absensi tidak ditemukan" });
		if (item.approval_status !== "Pending_Supervisor") {
			return res.status(400).json({ message: "Status absensi tidak valid untuk ditolak" });
		}

		await safeAloraMobileQuery(
			`UPDATE tr_worker_attendance SET
        approval_status = 'Rejected_Supervisor',
        supervisor_id = ?,
        supervisor_rejection_reason = ?,
        supervisor_approved_at = NULL,
        approved_by = NULL,
        approved_by_name = NULL,
        approved_at = NULL,
        updated_at = NOW()
       WHERE id = ?`,
			[currentEmpId, reason, id]
		);

		return res.json({ message: "Absensi berhasil ditolak." });
	} catch (err) {
		console.error("[alora attendance rejectSupervisor]", err);
		return res.status(500).json({ message: "Gagal melakukan penolakan supervisor" });
	}
};
