import path from "path";
import { safeQuery, safeMyWaschenQuery } from "../../../db/pool.js";
import {
  uploadWaschenPayslipFile,
  deleteWaschenPayslipFile,
  fetchWaschenPayslipFile,
} from "../../../utils/waschenMobileUpload.js";

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

async function assertWaschenEmployee(id) {
  const [rows] = await safeQuery(
    "SELECT employee_id FROM mst_employee WHERE employee_id = ? AND company_id = 5 AND is_deleted = 0 LIMIT 1",
    [id],
  );
  return rows.length > 0;
}

export const listWaschenPayslips = async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    if (!employeeId || !(await assertWaschenEmployee(employeeId))) {
      return res.status(404).json({ success: false, message: "Karyawan Waschen tidak ditemukan" });
    }
    const [rows] = await safeMyWaschenQuery(
      `SELECT id, employee_id, payslip_month, file_name, uploaded_by, created_at, updated_at
       FROM tr_payslip_waschen
       WHERE employee_id = ?
       ORDER BY payslip_month DESC, id DESC`,
      [employeeId],
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error("[listWaschenPayslips]", error);
    return res.status(500).json({ success: false, message: "Gagal memuat slip gaji" });
  }
};

export const uploadWaschenPayslip = async (req, res) => {
  let storedName = null;
  try {
    const employeeId = Number(req.params.id);
    const month = String(req.body?.payslip_month || "").trim();
    if (!employeeId || !(await assertWaschenEmployee(employeeId))) {
      return res.status(404).json({ success: false, message: "Karyawan Waschen tidak ditemukan" });
    }
    if (!MONTH_RE.test(month)) {
      return res.status(400).json({ success: false, message: "Bulan slip wajib format YYYY-MM" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "File slip gaji wajib diunggah" });
    }

    storedName = await uploadWaschenPayslipFile(req.file);
    const uploadedBy = req.session?.employeeId || req.session?.userId || null;
    const originalName = path.basename(String(req.file.originalname || storedName)).slice(0, 255);

    const [existing] = await safeMyWaschenQuery(
      "SELECT id, file_path FROM tr_payslip_waschen WHERE employee_id = ? AND payslip_month = ? LIMIT 1",
      [employeeId, month],
    );

    if (existing.length) {
      const oldPath = existing[0].file_path;
      await safeMyWaschenQuery(
        `UPDATE tr_payslip_waschen
         SET file_path = ?, file_name = ?, uploaded_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [storedName, originalName, uploadedBy, existing[0].id],
      );
      if (oldPath && oldPath !== storedName) await deleteWaschenPayslipFile(oldPath);
    } else {
      await safeMyWaschenQuery(
        `INSERT INTO tr_payslip_waschen (employee_id, payslip_month, file_path, file_name, uploaded_by)
         VALUES (?, ?, ?, ?, ?)`,
        [employeeId, month, storedName, originalName, uploadedBy],
      );
    }

    return res.json({ success: true, message: "Slip gaji berhasil diunggah" });
  } catch (error) {
    if (storedName) await deleteWaschenPayslipFile(storedName);
    console.error("[uploadWaschenPayslip]", error);
    const message = error.sql ? "Gagal mengunggah slip gaji" : (error.message || "Gagal mengunggah slip gaji");
    return res.status(500).json({ success: false, message });
  }
};

export const viewWaschenPayslip = async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const payslipId = Number(req.params.payslipId);
    if (!employeeId || !(await assertWaschenEmployee(employeeId))) {
      return res.status(404).json({ success: false, message: "Karyawan Waschen tidak ditemukan" });
    }
    const [rows] = await safeMyWaschenQuery(
      "SELECT file_path, file_name FROM tr_payslip_waschen WHERE id = ? AND employee_id = ? LIMIT 1",
      [payslipId, employeeId],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Slip gaji tidak ditemukan" });
    const file = await fetchWaschenPayslipFile(rows[0].file_path);
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(rows[0].file_name || "slip-gaji")}"`,
    );
    return res.send(file.buf);
  } catch (error) {
    console.error("[viewWaschenPayslip]", error);
    return res.status(500).json({ success: false, message: error.message || "Gagal membuka slip gaji" });
  }
};

export const deleteWaschenPayslip = async (req, res) => {
  try {
    const employeeId = Number(req.params.id);
    const payslipId = Number(req.params.payslipId);
    if (!employeeId || !(await assertWaschenEmployee(employeeId))) {
      return res.status(404).json({ success: false, message: "Karyawan Waschen tidak ditemukan" });
    }
    const [rows] = await safeMyWaschenQuery(
      "SELECT file_path FROM tr_payslip_waschen WHERE id = ? AND employee_id = ? LIMIT 1",
      [payslipId, employeeId],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Slip gaji tidak ditemukan" });
    await safeMyWaschenQuery("DELETE FROM tr_payslip_waschen WHERE id = ? AND employee_id = ?", [payslipId, employeeId]);
    await deleteWaschenPayslipFile(rows[0].file_path);
    return res.json({ success: true, message: "Slip gaji dihapus" });
  } catch (error) {
    console.error("[deleteWaschenPayslip]", error);
    return res.status(500).json({ success: false, message: "Gagal menghapus slip gaji" });
  }
};
