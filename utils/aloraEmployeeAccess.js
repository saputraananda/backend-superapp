import { safeQuery } from "../db/pool.js";

export const ALORA_COMPANY_ID = 1;
// Karyawan company lain yang ikut dikelola Alora (188 = Angel, IKM)
export const ALORA_EXTRA_EMPLOYEE_IDS = [188];
export const ALORA_COMPANY_CONDITION = ALORA_EXTRA_EMPLOYEE_IDS.length > 0
	? `(e.company_id = ${ALORA_COMPANY_ID} OR e.employee_id IN (${ALORA_EXTRA_EMPLOYEE_IDS.join(",")}))`
	: `e.company_id = ${ALORA_COMPANY_ID}`;
export const ALORA_HRD_POSITION_IDS = [1, 8, 17, 18, 19];
export const ALORA_ACTIVE_EMPLOYEE_CONDITION = "e.exit_date IS NULL AND e.employment_status_id IS NOT NULL";

export async function assertAloraHrd(req) {
	const currentEmpId = req.session?.employeeId;
	if (!currentEmpId) {
		const error = new Error("Sesi karyawan tidak valid");
		error.statusCode = 400;
		throw error;
	}
	const [rows] = await safeQuery(
		"SELECT position_id FROM mst_employee WHERE employee_id = ? AND is_deleted = 0 LIMIT 1",
		[currentEmpId]
	);
	const positionId = Number(rows?.[0]?.position_id);
	if (!ALORA_HRD_POSITION_IDS.includes(positionId)) {
		const error = new Error("Hanya HRD yang dapat mengelola slip gaji");
		error.statusCode = 403;
		throw error;
	}
	return { currentEmpId };
}
