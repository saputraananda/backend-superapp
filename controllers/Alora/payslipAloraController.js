import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";
import {
	ALORA_ACTIVE_EMPLOYEE_CONDITION,
	ALORA_COMPANY_CONDITION,
	assertAloraHrd,
} from "../../utils/aloraEmployeeAccess.js";
import {
	deleteAloraMobilePayslipFile,
	proxyAloraMobileFile,
	uploadAloraMobilePayslipFile,
} from "../../utils/aloraMobileApiAssets.js";

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function buildPayslipMonth(month, year) {
	const m = Number(month);
	const y = Number(year);
	if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 2000 || y > 2100) {
		const error = new Error("Bulan atau tahun tidak valid");
		error.statusCode = 400;
		throw error;
	}
	return `${y}-${String(m).padStart(2, "0")}`;
}

async function findActiveAloraEmployee(employeeId) {
	const [rows] = await safeQuery(
		`SELECT e.employee_id, e.full_name
     FROM mst_employee e
     WHERE e.employee_id = ? AND e.is_deleted = 0 AND ${ALORA_COMPANY_CONDITION} AND ${ALORA_ACTIVE_EMPLOYEE_CONDITION}
     LIMIT 1`,
		[employeeId]
	);
	return rows[0] || null;
}

function sendError(res, err, logLabel, fallbackMessage) {
	const status = err.statusCode || 500;
	if (status === 500) console.error(`[alora ${logLabel}]`, err);
	return res.status(status).json({ message: err.message || fallbackMessage });
}

export const listPayslipEmployees = async (req, res) => {
	try {
		await assertAloraHrd(req);

		const search = String(req.query.search || "").trim();
		const page = Math.max(1, Number(req.query.page) || 1);
		let limit = Number(req.query.limit) || 20;
		if (![20, 50, 100].includes(limit)) limit = 20;
		const offset = (page - 1) * limit;

		const where = ["e.is_deleted = 0", ALORA_COMPANY_CONDITION, ALORA_ACTIVE_EMPLOYEE_CONDITION];
		const params = [];
		if (search) {
			where.push(
				`(e.full_name LIKE ? OR e.employee_code LIKE ? OR CAST(e.employee_id AS CHAR) LIKE ?)`
			);
			const like = `%${search}%`;
			params.push(like, like, like);
		}
		const whereSql = where.join(" AND ");

		const [[countRow]] = await safeQuery(
			`SELECT COUNT(*) AS total FROM mst_employee e WHERE ${whereSql}`,
			params
		);
		const total = Number(countRow?.total) || 0;
		const totalPages = Math.max(1, Math.ceil(total / limit) || 1);

		const [employees] = await safeQuery(
			`SELECT e.employee_id, e.full_name, e.employee_code, d.department_name
       FROM mst_employee e
       LEFT JOIN mst_department d ON e.department_id = d.department_id
       WHERE ${whereSql}
       ORDER BY e.full_name ASC
       LIMIT ? OFFSET ?`,
			[...params, limit, offset]
		);

		const ids = (employees || []).map((e) => Number(e.employee_id));
		const summaryMap = new Map();
		if (ids.length > 0) {
			const [summaryRows] = await safeAloraMobileQuery(
				`SELECT employee_id, COUNT(*) AS payslip_count, MAX(payslip_month) AS latest_payslip_month
         FROM tr_payslip_alora
         WHERE employee_id IN (?)
         GROUP BY employee_id`,
				[ids]
			);
			for (const row of summaryRows || []) {
				summaryMap.set(Number(row.employee_id), row);
			}
		}

		const items = (employees || []).map((emp) => {
			const summary = summaryMap.get(Number(emp.employee_id));
			return {
				employee_id: Number(emp.employee_id),
				full_name: emp.full_name,
				employee_code: emp.employee_code,
				department_name: emp.department_name || null,
				payslip_count: Number(summary?.payslip_count) || 0,
				latest_payslip_month: summary?.latest_payslip_month || null,
			};
		});

		return res.json({ items, pagination: { page, limit, total, totalPages } });
	} catch (err) {
		return sendError(res, err, "listPayslipEmployees", "Gagal memuat daftar karyawan");
	}
};

export const listEmployeePayslips = async (req, res) => {
	try {
		await assertAloraHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) return res.status(400).json({ message: "employeeId tidak valid" });

		const [rows] = await safeAloraMobileQuery(
			`SELECT id, employee_id, payslip_month, file_name, uploaded_by, created_at, updated_at
       FROM tr_payslip_alora
       WHERE employee_id = ?
       ORDER BY payslip_month DESC`,
			[employeeId]
		);
		return res.json({ items: rows || [] });
	} catch (err) {
		return sendError(res, err, "listEmployeePayslips", "Gagal memuat slip gaji");
	}
};

export const uploadEmployeePayslip = async (req, res) => {
	try {
		const { currentEmpId } = await assertAloraHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		if (!employeeId) {
			return res.status(400).json({ message: "employeeId tidak valid" });
		}
		if (!req.file) {
			return res.status(400).json({ message: "File PDF wajib diupload" });
		}
		const payslipMonth = buildPayslipMonth(req.body?.month, req.body?.year);

		const employee = await findActiveAloraEmployee(employeeId);
		if (!employee) {
			return res.status(404).json({ message: "Karyawan aktif tidak ditemukan" });
		}

		const [[existing]] = await safeAloraMobileQuery(
			"SELECT id, file_path FROM tr_payslip_alora WHERE employee_id = ? AND payslip_month = ? LIMIT 1",
			[employeeId, payslipMonth]
		);

		const filePath = await uploadAloraMobilePayslipFile(req.file.buffer, req.file.originalname);
		const fileName = req.file.originalname;

		try {
			if (existing) {
				await safeAloraMobileQuery(
					"UPDATE tr_payslip_alora SET file_path = ?, file_name = ?, uploaded_by = ?, updated_at = NOW() WHERE id = ?",
					[filePath, fileName, currentEmpId, existing.id]
				);
			} else {
				await safeAloraMobileQuery(
					"INSERT INTO tr_payslip_alora (employee_id, payslip_month, file_path, file_name, uploaded_by) VALUES (?, ?, ?, ?, ?)",
					[employeeId, payslipMonth, filePath, fileName, currentEmpId]
				);
			}
		} catch (dbErr) {
			await deleteAloraMobilePayslipFile(filePath);
			throw dbErr;
		}

		if (existing) {
			await deleteAloraMobilePayslipFile(existing.file_path);
		}

		return res.json({
			message: existing ? "Slip gaji diperbarui" : "Slip gaji berhasil diupload",
			payslip_month: payslipMonth,
			replaced: Boolean(existing),
		});
	} catch (err) {
		return sendError(res, err, "uploadEmployeePayslip", "Gagal mengupload slip gaji");
	}
};

function monthConflictMessage(payslipMonth) {
	return `Slip ${payslipMonth} sudah ada. Hapus slip tersebut dulu atau pilih bulan lain.`;
}

export const updateEmployeePayslip = async (req, res) => {
	let payslipMonth = null;
	try {
		const { currentEmpId } = await assertAloraHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		const payslipId = toPositiveInt(req.params.payslipId);
		if (!employeeId || !payslipId) {
			return res.status(400).json({ message: "Parameter tidak valid" });
		}
		payslipMonth = buildPayslipMonth(req.body?.month, req.body?.year);

		const [[row]] = await safeAloraMobileQuery(
			"SELECT id, payslip_month, file_path FROM tr_payslip_alora WHERE id = ? AND employee_id = ? LIMIT 1",
			[payslipId, employeeId]
		);
		if (!row) {
			return res.status(404).json({ message: "Slip gaji tidak ditemukan" });
		}

		const monthChanged = payslipMonth !== row.payslip_month;
		if (monthChanged) {
			const [[conflict]] = await safeAloraMobileQuery(
				"SELECT id FROM tr_payslip_alora WHERE employee_id = ? AND payslip_month = ? AND id <> ? LIMIT 1",
				[employeeId, payslipMonth, payslipId]
			);
			if (conflict) {
				return res.status(409).json({ message: monthConflictMessage(payslipMonth) });
			}
		}

		if (!req.file && !monthChanged) {
			return res.status(400).json({ message: "Tidak ada perubahan" });
		}

		if (req.file) {
			const newFilePath = await uploadAloraMobilePayslipFile(req.file.buffer, req.file.originalname);
			try {
				await safeAloraMobileQuery(
					"UPDATE tr_payslip_alora SET payslip_month = ?, file_path = ?, file_name = ?, uploaded_by = ?, updated_at = NOW() WHERE id = ?",
					[payslipMonth, newFilePath, req.file.originalname, currentEmpId, row.id]
				);
			} catch (dbErr) {
				await deleteAloraMobilePayslipFile(newFilePath);
				throw dbErr;
			}
			await deleteAloraMobilePayslipFile(row.file_path);
		} else {
			await safeAloraMobileQuery(
				"UPDATE tr_payslip_alora SET payslip_month = ?, uploaded_by = ?, updated_at = NOW() WHERE id = ?",
				[payslipMonth, currentEmpId, row.id]
			);
		}

		return res.json({ message: "Slip gaji diperbarui", payslip_month: payslipMonth });
	} catch (err) {
		if (err.code === "ER_DUP_ENTRY") {
			return res.status(409).json({ message: monthConflictMessage(payslipMonth) });
		}
		return sendError(res, err, "updateEmployeePayslip", "Gagal memperbarui slip gaji");
	}
};

export const viewEmployeePayslip = async (req, res) => {
	try {
		await assertAloraHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		const payslipId = toPositiveInt(req.params.payslipId);
		if (!employeeId || !payslipId) return res.status(400).json({ message: "Parameter tidak valid" });

		const [[row]] = await safeAloraMobileQuery(
			"SELECT file_path, file_name FROM tr_payslip_alora WHERE id = ? AND employee_id = ? LIMIT 1",
			[payslipId, employeeId]
		);
		if (!row) return res.status(404).json({ message: "Slip gaji tidak ditemukan" });

		const safeName = String(row.file_name || "slip-gaji.pdf").replace(/"/g, "");
		res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
		const sent = await proxyAloraMobileFile("payslip", row.file_path, res);
		if (!sent) {
			res.removeHeader("Content-Disposition");
			return res
				.status(500)
				.json({ message: "ALORA_MOBILE_API_BASE_URL / ALORA_MOBILE_FILE_SECRET belum dikonfigurasi" });
		}
		return undefined;
	} catch (err) {
		if (res.headersSent) return undefined;
		return sendError(res, err, "viewEmployeePayslip", "Gagal memuat slip gaji");
	}
};

export const deleteEmployeePayslip = async (req, res) => {
	try {
		await assertAloraHrd(req);
		const employeeId = toPositiveInt(req.params.employeeId);
		const payslipId = toPositiveInt(req.params.payslipId);
		if (!employeeId || !payslipId) return res.status(400).json({ message: "Parameter tidak valid" });

		const [[row]] = await safeAloraMobileQuery(
			"SELECT id, file_path FROM tr_payslip_alora WHERE id = ? AND employee_id = ? LIMIT 1",
			[payslipId, employeeId]
		);
		if (!row) return res.status(404).json({ message: "Slip gaji tidak ditemukan" });

		await safeAloraMobileQuery("DELETE FROM tr_payslip_alora WHERE id = ?", [row.id]);
		await deleteAloraMobilePayslipFile(row.file_path);

		return res.json({ message: "Slip gaji dihapus" });
	} catch (err) {
		return sendError(res, err, "deleteEmployeePayslip", "Gagal menghapus slip gaji");
	}
};
