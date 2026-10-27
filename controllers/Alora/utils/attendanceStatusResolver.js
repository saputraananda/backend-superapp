export const FINAL_STATUS_PRIORITY = [
	"CUTI",
	"SAKIT_SKD",
	"SAKIT_NON_SKD",
	"WFA",
	"EARNED_REPLACE_OFF",
	"HALF_DAY",
	"REPLACE_OFF",
	"OVERTIME_LEAVE",
	"UNPAID_LEAVE",
	"HADIR",
	"OFF",
];

const STATUS_LABELS = {
	CUTI: "Cuti",
	SAKIT_SKD: "Sakit (SKD)",
	SAKIT_NON_SKD: "Sakit (Non-SKD)",
	WFA: "WFA",
	EARNED_REPLACE_OFF: "Earned Replace Off",
	HALF_DAY: "Half Day",
	REPLACE_OFF: "Replace Off",
	OVERTIME_LEAVE: "Overtime Leave",
	UNPAID_LEAVE: "Unpaid Leave",
	HADIR: "Hadir",
	OFF: "Off",
};

const PARTIAL_DURATION_TYPES = new Set([
	"partial",
	"half_day",
	"half_day_morning",
	"half_day_afternoon",
]);

function mapLeaveToStatuses(leave, attendance = null) {
	if (!leave || leave.status !== "disetujui") return [];
	const type = String(leave.leave_type || "").toLowerCase();
	const durationType = String(leave.duration_type || "").toLowerCase();
	const isPartial = PARTIAL_DURATION_TYPES.has(durationType);

	// Jika ada izin/cuti setengah hari (partial) dan karyawan hadir bekerja (ada clock_in)
	if (isPartial && attendance?.clock_in) {
		return ["HALF_DAY"];
	}

	if (type === "cuti") {
		return isPartial ? ["HALF_DAY"] : ["CUTI"];
	}
	if (type === "sakit") {
		return leave.doctor_note_path ? ["SAKIT_SKD"] : ["SAKIT_NON_SKD"];
	}
	if (type === "wfa") return ["WFA"];
	if (type === "izin") {
		const statuses = [];
		const ro = Number(leave.funding_ro_hours || 0);
		const ot = Number(leave.funding_overtime_hours || 0);
		const unpaid = Number(leave.funding_unpaid_hours || 0);
		if (isPartial) statuses.push("HALF_DAY");
		if (ro > 0) statuses.push("REPLACE_OFF");
		if (ot > 0) statuses.push("OVERTIME_LEAVE");
		if (unpaid > 0) statuses.push("UNPAID_LEAVE");
		if (statuses.length === 0) {
			statuses.push(isPartial ? "HALF_DAY" : "REPLACE_OFF");
		}
		return statuses;
	}
	return [];
}

function mapAttendanceToStatuses(attendance) {
	if (!attendance?.clock_in) return [];
	if (attendance.attendance_mode === "wod" && attendance.approval_status === "disetujui") {
		return ["EARNED_REPLACE_OFF"];
	}
	if (attendance.attendance_mode === "wfa" && attendance.approval_status === "disetujui") {
		return ["WFA"];
	}
	return ["HADIR"];
}

function mapSessionToStatuses(session) {
	if (!session || session.status !== "disetujui") return [];
	if (session.session_type === "earned_replace_off") return ["EARNED_REPLACE_OFF"];
	return [];
}

export function resolveFinalStatus({ date, attendance = null, leaves = [], sessions = [] }) {
	const candidates = new Set();

	for (const leave of leaves) {
		const start = String(leave.start_date).slice(0, 10);
		const end = String(leave.end_date).slice(0, 10);
		if (date >= start && date <= end) {
			mapLeaveToStatuses(leave, attendance).forEach((s) => candidates.add(s));
		}
	}

	for (const session of sessions) {
		const workDate = String(session.work_date).slice(0, 10);
		if (workDate === date) {
			mapSessionToStatuses(session).forEach((s) => candidates.add(s));
		}
	}

	if (attendance) {
		mapAttendanceToStatuses(attendance).forEach((s) => candidates.add(s));
	}

	let approval_pending = false;
	if (
		attendance?.clock_in
		&& (attendance.attendance_mode === "wfa" || attendance.attendance_mode === "wod")
		&& attendance.approval_status === "Pending_Supervisor"
	) {
		approval_pending = true;
	}

	let primary_status = "OFF";
	for (const status of FINAL_STATUS_PRIORITY) {
		if (candidates.has(status)) {
			primary_status = status;
			break;
		}
	}

	let late_flag = null;
	if (
		primary_status === "HADIR"
		&& (
			(attendance?.late_minutes != null && Number(attendance.late_minutes) > 0)
			|| Boolean(String(attendance?.late_reason || "").trim())
			|| Boolean(attendance?.late_category)
		)
	) {
		late_flag = "late";
	}

	const labels = [STATUS_LABELS[primary_status] || primary_status];
	if (late_flag) labels.push("Terlambat");
	if (approval_pending) labels.push("Menunggu approval");

	return {
		primary_status,
		late_flag,
		approval_pending,
		labels,
		status_label: labels.join(" · "),
	};
}
