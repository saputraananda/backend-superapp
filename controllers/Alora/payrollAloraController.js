import { safeAloraMobileQuery, safeQuery } from "../../db/pool.js";
import {
	ALORA_COMPANY_CONDITION,
	ALORA_ACTIVE_EMPLOYEE_CONDITION,
} from "./utils/aloraEmployeeAccess.js";

function toISODateString(value) {
	return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value : null;
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
	const fmt = (d) => {
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${y}-${m}-${day}`;
	};
	return { startDate: fmt(start), endDate: fmt(end) };
}

function getDaysInRange(startDate, endDate) {
	const dates = [];
	const curr = new Date(`${startDate}T12:00:00+07:00`);
	const end = new Date(`${endDate}T12:00:00+07:00`);
	while (curr <= end) {
		dates.push(curr.toISOString().slice(0, 10));
		curr.setDate(curr.getDate() + 1);
	}
	return dates;
}

export const getPayrollRekap = async (req, res) => {
	try {
		const defaults = getDefaultCutoffRange();
		const startDate = toISODateString(req.query.startDate) || defaults.startDate;
		const endDate = toISODateString(req.query.endDate) || defaults.endDate;

		if (new Date(endDate) < new Date(startDate)) {
			return res.status(400).json({ message: "endDate tidak boleh lebih kecil dari startDate" });
		}

		const rawDept = String(req.query.departmentId || req.query.departmentName || "").trim();
		const departmentId = Number(rawDept);
		const search = String(req.query.search || "").trim().toLowerCase();

		// 1. Fetch holidays from mst_holiday
		const [holidayRows] = await safeAloraMobileQuery(
			`SELECT holiday_date FROM mst_holiday WHERE holiday_date >= ? AND holiday_date <= ?`,
			[startDate, endDate]
		);
		const holidaySet = new Set(holidayRows.map((h) => String(h.holiday_date).slice(0, 10)));

		// 2. Determine all dates & working days in cutoff range
		const allDates = getDaysInRange(startDate, endDate);
		const workingDatesSet = new Set();
		allDates.forEach((dStr) => {
			const dow = new Date(`${dStr}T12:00:00+07:00`).getDay();
			// Day 0 is Sunday. Saturdays (Day 6) is a working day (half-day 5h in Alora).
			// If not Sunday and not in holidaySet, consider working day.
			if (dow !== 0 && !holidaySet.has(dStr)) {
				workingDatesSet.add(dStr);
			}
		});
		const totalWorkingDays = workingDatesSet.size;

		// 3. Fetch active Alora employees
		let empSql = `
			SELECT 
				e.employee_id,
				e.employee_code,
				e.full_name,
				e.department_id,
				d.department_name,
				e.position_id,
				p.position_name AS jabatan,
				e.join_date,
				e.take_home_pay
			FROM mst_employee e
			LEFT JOIN mst_department d ON e.department_id = d.department_id
			LEFT JOIN mst_position p ON e.position_id = p.position_id
			WHERE ${ALORA_COMPANY_CONDITION} 
			  AND ${ALORA_ACTIVE_EMPLOYEE_CONDITION}
		`;
		const empParams = [];
		if (Number.isInteger(departmentId) && departmentId > 0) {
			empSql += ` AND e.department_id = ?`;
			empParams.push(departmentId);
		} else if (rawDept) {
			empSql += ` AND d.department_name = ?`;
			empParams.push(rawDept);
		}
		empSql += ` ORDER BY e.full_name ASC`;

		const [employees] = await safeQuery(empSql, empParams);

		// Filter by search if provided
		const filteredEmployees = search
			? employees.filter((e) =>
				String(e.full_name || "").toLowerCase().includes(search) ||
				String(e.employee_code || "").toLowerCase().includes(search)
			)
			: employees;

		if (filteredEmployees.length === 0) {
			return res.json({
				period: { startDate, endDate, totalDays: allDates.length, totalWorkingDays },
				summary: {
					totalEmployees: 0,
					totalKehadiran: 0,
					totalLemburHours: 0,
					totalPotPerJam: 0,
					totalKonsumsiTelatCount: 0,
					totalKonsumsiUnpaidDays: 0,
				},
				data: [],
			});
		}

		const empIds = filteredEmployees.map((e) => Number(e.employee_id));

		// 4. Fetch Attendance records
		const [attRows] = await safeAloraMobileQuery(
			`SELECT 
				employee_id,
				DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date,
				attendance_mode,
				clock_in,
				clock_out,
				late_category,
				late_minutes,
				is_late_waived,
				late_compensation_type,
				late_compensation_hours
			FROM tr_worker_attendance
			WHERE attendance_date >= ? AND attendance_date <= ?
			  AND employee_id IN (?)`,
			[startDate, endDate, empIds]
		);

		// Map attendance by `${employee_id}|${attendance_date}`
		const attMap = new Map();
		attRows.forEach((att) => {
			attMap.set(`${att.employee_id}|${att.attendance_date}`, att);
		});

		// 5. Fetch Approved Leaves
		const [leaveRows] = await safeAloraMobileQuery(
			`SELECT 
				id,
				employee_id,
				leave_type,
				duration_type,
				DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
				DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
				leave_days,
				leave_duration_hours,
				funding_sources,
				funding_ro_hours,
				funding_overtime_hours,
				funding_unpaid_hours,
				doctor_note_path,
				doctor_note_file
			FROM tr_worker_leaves
			WHERE status = 'approved'
			  AND start_date <= ? AND end_date >= ?
			  AND employee_id IN (?)`,
			[endDate, startDate, empIds]
		);

		// Map leaves by employee
		const leavesByEmp = new Map();
		leaveRows.forEach((leave) => {
			const arr = leavesByEmp.get(Number(leave.employee_id)) || [];
			arr.push(leave);
			leavesByEmp.set(Number(leave.employee_id), arr);
		});

		// 6. Fetch Overtime approved & overtime ledger used (debit)
		const [otApprovedRows] = await safeAloraMobileQuery(
			`SELECT 
				employee_id,
				COALESCE(SUM(duration_hours), 0) AS total_approved_ot
			FROM tr_worker_lembur_ro
			WHERE request_type = 'lembur' AND status = 'approved'
			  AND work_date >= ? AND work_date <= ?
			  AND employee_id IN (?)
			GROUP BY employee_id`,
			[startDate, endDate, empIds]
		);
		const otApprovedMap = new Map();
		otApprovedRows.forEach((r) => {
			otApprovedMap.set(Number(r.employee_id), Number(r.total_approved_ot) || 0);
		});

		const [otUsedRows] = await safeAloraMobileQuery(
			`SELECT 
				employee_id,
				COALESCE(SUM(ABS(hours)), 0) AS total_used_ot
			FROM tr_overtime_ledger
			WHERE mutation_type = 'debit'
			  AND DATE(created_at) >= ? AND DATE(created_at) <= ?
			  AND employee_id IN (?)
			GROUP BY employee_id`,
			[startDate, endDate, empIds]
		);
		const otUsedMap = new Map();
		otUsedRows.forEach((r) => {
			otUsedMap.set(Number(r.employee_id), Number(r.total_used_ot) || 0);
		});

		// 7. Calculate Payroll Metrics per Employee
		let grandKehadiran = 0;
		let grandLemburHours = 0;
		let grandPotPerJam = 0;
		let grandKonsumsiTelatCount = 0;
		let grandKonsumsiUnpaidDays = 0;

		const payrollData = filteredEmployees.map((emp) => {
			const empId = Number(emp.employee_id);
			const empLeaves = leavesByEmp.get(empId) || [];

			// Track attendance & leave status across each working day
			let hadirHarianCount = 0;
			let wfaCount = 0;
			let wodCount = 0;
			let sakitSkdCount = 0;
			let sakitNonSkdCount = 0;
			let roCount = 0;
			let cutiCount = 0;
			let izinSeharianLemburCount = 0;
			let izinSeharianUnpaidCount = 0;
			let izinHalfDayCount = 0;

			let potPerJamHours = 0;
			let konsumsiTelatCount = 0;

			// Check half-day unpaid and overtime uncovered hours from leaves
			empLeaves.forEach((lv) => {
				const unpaidH = Number(lv.funding_unpaid_hours) || 0;
				if (lv.duration_type === "half_day") {
					izinHalfDayCount += 1;
					if (unpaidH > 0) {
						potPerJamHours += unpaidH;
					}
				} else if (unpaidH > 0 && String(lv.funding_sources || "").includes("overtime")) {
					// Izin pakai lembur tapi ada sisa jam yang tidak tercover
					potPerJamHours += unpaidH;
				}
			});

			// Loop through all dates in the period
			allDates.forEach((dStr) => {
				const isWorkingDay = workingDatesSet.has(dStr);
				const att = attMap.get(`${empId}|${dStr}`);

				// Find leave covering this date
				const leaveOnDate = empLeaves.find((lv) => {
					return lv.start_date <= dStr && lv.end_date >= dStr;
				});

				if (att && att.clock_in) {
					const mode = String(att.attendance_mode || "WFO").toUpperCase();
					if (mode === "WFA" || mode === "WFH") {
						wfaCount += 1;
					} else if (mode === "WOD") {
						wodCount += 1;
					} else {
						hadirHarianCount += 1;
					}

					// Late check
					const clockInTime = new Date(att.clock_in);
					const h = clockInTime.getHours();
					const m = clockInTime.getMinutes();
					const s = clockInTime.getSeconds();
					const totalSeconds = h * 3600 + m * 60 + s;
					const limitToleranceSec = 8 * 3600 + 30 * 60 + 59; // 08:30:59
					const limit9Sec = 9 * 3600; // 09:00:00

					if (totalSeconds > limitToleranceSec) {
						if (totalSeconds < limit9Sec) {
							// Konsumsi (Telat): telat < 09:00
							konsumsiTelatCount += 1;
						} else {
							// Telat >= 09:00: masuk ke Pot per Jam jika belum dimaafkan / tercover lembur
							if (!att.is_late_waived || att.late_compensation_type === "pending_overtime") {
								const compH = Number(att.late_compensation_hours) || (att.late_minutes ? Math.ceil(Number(att.late_minutes) / 60) : 1);
								potPerJamHours += compH;
							}
						}
					}
				} else if (leaveOnDate && isWorkingDay) {
					const lType = String(leaveOnDate.leave_type || "").toLowerCase();
					const dType = String(leaveOnDate.duration_type || "").toLowerCase();

					if (lType === "sakit") {
						if (leaveOnDate.doctor_note_path || leaveOnDate.doctor_note_file) {
							sakitSkdCount += 1;
						} else {
							sakitNonSkdCount += 1;
						}
					} else if (lType === "replace_off") {
						roCount += 1;
					} else if (lType === "tahunan" || lType === "cuti") {
						cutiCount += 1;
					} else if (dType === "full_day") {
						const fSrc = String(leaveOnDate.funding_sources || "").toLowerCase();
						if (fSrc.includes("overtime") && Number(leaveOnDate.funding_unpaid_hours || 0) === 0) {
							izinSeharianLemburCount += 1;
						} else {
							izinSeharianUnpaidCount += 1;
						}
					}
				}
			});

			// Formula 1: Kehadiran (Paid Days)
			// hadir harian + WFA + sakit SKD + RO + cuti + izin seharian pakai lembur + semua izin setengah hari
			const totalKehadiran = hadirHarianCount + wfaCount + sakitSkdCount + roCount + cutiCount + izinSeharianLemburCount + izinHalfDayCount;

			// Formula 2: OFF
			// tidak hadir harian + WOD + sakit non-SKD + izin seharian unpaid
			const tidakHadirHarian = Math.max(0, totalWorkingDays - (hadirHarianCount + wfaCount + sakitSkdCount + roCount + cutiCount + izinSeharianLemburCount + izinHalfDayCount + wodCount + sakitNonSkdCount + izinSeharianUnpaidCount));
			const totalOff = tidakHadirHarian + wodCount + sakitNonSkdCount + izinSeharianUnpaidCount;

			// Formula 3: Lembur Reguler
			// lembur bersih, setelah dikurangi lembur yang sudah dipakai
			const totalApprovedOt = otApprovedMap.get(empId) || 0;
			const totalUsedOt = otUsedMap.get(empId) || 0;
			const lemburReguler = Math.max(0, totalApprovedOt - totalUsedOt);

			// Formula 4: Unpaid Leave
			// total hari kerja - total kehadiran
			const unpaidLeave = Math.max(0, totalWorkingDays - totalKehadiran);

			// Formula 6 & 7: Konsumsi (Unpaid) & Transportasi (Unpaid)
			// sakit SKD dan non-SKD + WFA + izin seharian unpaid + izin seharian pakai lembur + WOD
			const konsumsiUnpaidDays = sakitSkdCount + sakitNonSkdCount + wfaCount + izinSeharianUnpaidCount + izinSeharianLemburCount + wodCount;
			const transportUnpaidDays = konsumsiUnpaidDays;

			// Round pot per jam to 2 decimals
			potPerJamHours = Math.round(potPerJamHours * 100) / 100;

			grandKehadiran += totalKehadiran;
			grandLemburHours += lemburReguler;
			grandPotPerJam += potPerJamHours;
			grandKonsumsiTelatCount += konsumsiTelatCount;
			grandKonsumsiUnpaidDays += konsumsiUnpaidDays;

			return {
				employee_id: empId,
				employee_code: emp.employee_code || "-",
				employee_name: emp.full_name || "-",
				department_name: emp.department_name || "-",
				jabatan: emp.jabatan || "-",
				join_date: emp.join_date ? String(emp.join_date).slice(0, 10) : "-",
				take_home_pay: emp.take_home_pay ? Number(emp.take_home_pay) : null,

				// Standard Payroll Columns
				kehadiran: totalKehadiran,
				off: totalOff,
				lembur_reguler: lemburReguler,
				unpaid_leave: unpaidLeave,

				// BLUE COLUMNS (Master Gaji Columns W, Z, AA, AC)
				pot_per_jam: potPerJamHours,
				konsumsi_telat: konsumsiTelatCount,
				konsumsi_unpaid: konsumsiUnpaidDays,
				transportasi_unpaid: transportUnpaidDays,

				// Breakdown info for HR clarity
				breakdown: {
					hadir_harian: hadirHarianCount,
					wfa: wfaCount,
					wod: wodCount,
					sakit_skd: sakitSkdCount,
					sakit_non_skd: sakitNonSkdCount,
					ro: roCount,
					cuti: cutiCount,
					izin_seharian_lembur: izinSeharianLemburCount,
					izin_seharian_unpaid: izinSeharianUnpaidCount,
					izin_half_day: izinHalfDayCount,
					approved_ot: totalApprovedOt,
					used_ot: totalUsedOt,
				},
			};
		});

		return res.json({
			period: {
				startDate,
				endDate,
				totalDays: allDates.length,
				totalWorkingDays,
			},
			summary: {
				totalEmployees: payrollData.length,
				totalKehadiran: grandKehadiran,
				totalLemburHours: Math.round(grandLemburHours * 100) / 100,
				totalPotPerJam: Math.round(grandPotPerJam * 100) / 100,
				totalKonsumsiTelatCount: grandKonsumsiTelatCount,
				totalKonsumsiUnpaidDays: grandKonsumsiUnpaidDays,
			},
			data: payrollData,
		});
	} catch (error) {
		console.error("Error in getPayrollRekap:", error);
		return res.status(500).json({
			message: "Terjadi kesalahan saat memproses data rekap payroll",
			error: error.message,
		});
	}
};
