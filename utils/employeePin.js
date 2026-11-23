import { safeQuery } from "../db/pool.js";

/**
 * PIN karyawan (4 digit, unik) — tabel mst_employee_pin di DB utama (waschen).
 * Satu PIN per karyawan, dipakai bersama POS, SuperApp, Waschen Mobile, dan IKM Mobile.
 */

/** Map<employee_id, pin> untuk daftar id (kosong = semua). */
export async function getEmployeePinMap(ids) {
  const list = ids ? [...new Set(ids.map(Number).filter(Boolean))] : null;
  if (list && !list.length) return new Map();
  const [rows] = list
    ? await safeQuery("SELECT employee_id, pin FROM mst_employee_pin WHERE employee_id IN (?)", [list])
    : await safeQuery("SELECT employee_id, pin FROM mst_employee_pin");
  return new Map(rows.map((r) => [Number(r.employee_id), String(r.pin)]));
}

/**
 * Validasi input PIN. Kosong/null = hapus PIN.
 * @returns {{ pin: string|null } | { status: number, message: string }}
 */
export function parsePinInput(raw) {
  if (raw === null || raw === undefined || raw === "" || raw === "null") return { pin: null };
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length !== 4) return { status: 400, message: "PIN harus 4 digit angka." };
  return { pin: digits };
}

/** Simpan/hapus PIN. null = berhasil, atau { status, message } bila PIN sudah dipakai. */
export async function saveEmployeePin(employeeId, pin) {
  if (!pin) {
    await safeQuery("DELETE FROM mst_employee_pin WHERE employee_id = ?", [employeeId]);
    return null;
  }
  const taken = { status: 409, message: `PIN ${pin} sudah dipakai karyawan lain. Gunakan PIN unik.` };
  // Bukan ON DUPLICATE KEY UPDATE: bentrok di kunci unik `pin` akan meng-update baris karyawan lain.
  try {
    const [dup] = await safeQuery(
      "SELECT employee_id FROM mst_employee_pin WHERE pin = ? AND employee_id <> ? LIMIT 1",
      [pin, employeeId]
    );
    if (dup.length) return taken;
    const [upd] = await safeQuery("UPDATE mst_employee_pin SET pin = ? WHERE employee_id = ?", [pin, employeeId]);
    if (!upd.affectedRows) {
      await safeQuery("INSERT INTO mst_employee_pin (employee_id, pin) VALUES (?, ?)", [employeeId, pin]);
    }
    return null;
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return taken;
    throw err;
  }
}
