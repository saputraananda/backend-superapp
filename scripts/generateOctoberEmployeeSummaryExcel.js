import ExcelJS from "exceljs";
import path from "path";
import { safeQuery, safeAloraMobileQuery } from "../db/pool.js";

const START_DATE = "2026-09-26";
const END_DATE = "2026-10-25";
const PERIOD_LABEL = "26 September 2026 s.d. 25 Oktober 2026 (Cutoff Oktober 2026)";

const INDO_DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const INDO_MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

function fmtDateIndo(dateStr) {
  if (!dateStr) return "-";
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return `${d} ${INDO_MONTHS[m - 1]} ${y}`;
}

function fmtTime(timeStr) {
  if (!timeStr) return "-";
  const s = String(timeStr);
  if (s.includes("T")) {
    const parts = s.split("T")[1]?.slice(0, 5);
    return parts ? `${parts} WIB` : "-";
  }
  if (s.includes(" ")) {
    const parts = s.split(" ")[1]?.slice(0, 5);
    return parts ? `${parts} WIB` : "-";
  }
  return s.slice(0, 5) ? `${s.slice(0, 5)} WIB` : "-";
}

function getDatesInRange(startStr, endStr) {
  const dates = [];
  let curr = new Date(`${startStr}T12:00:00+07:00`);
  const end = new Date(`${endStr}T12:00:00+07:00`);
  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, "0");
    const d = String(curr.getDate()).padStart(2, "0");
    const dateStr = `${y}-${m}-${d}`;
    const dow = curr.getDay();
    dates.push({
      dateStr,
      dayName: INDO_DAYS[dow],
      dayOfWeek: dow,
      isWorkingDay: dow !== 0, // Minggu libur rutin
    });
    curr.setDate(curr.getDate() + 1);
  }
  return dates;
}

function borderAll(color = "D1D5DB") {
  return {
    top: { style: "thin", color: { argb: `FF${color}` } },
    left: { style: "thin", color: { argb: `FF${color}` } },
    bottom: { style: "thin", color: { argb: `FF${color}` } },
    right: { style: "thin", color: { argb: `FF${color}` } },
  };
}

async function generateExcel() {
  console.log(`[EXCEL GENERATOR] Memulai pembuatan Rekap Absensi Periode: ${PERIOD_LABEL}`);

  // 1. Ambil data karyawan Alora Group
  const [employees] = await safeQuery(`
    SELECT e.employee_id, e.employee_code, e.full_name, e.department_id,
           d.department_name, p.position_name
    FROM mst_employee e
    LEFT JOIN mst_department d ON d.department_id = e.department_id
    LEFT JOIN mst_position p ON p.position_id = e.position_id
    WHERE (e.company_id = 1 OR e.employee_id = 188)
      AND e.is_deleted = 0
      AND e.exit_date IS NULL
    ORDER BY d.department_name ASC, e.full_name ASC
  `);
  console.log(`[EXCEL GENERATOR] Total karyawan aktif: ${employees.length}`);

  const employeeIds = employees.map((e) => e.employee_id);
  const placeholders = employeeIds.map(() => "?").join(",");

  // 2. Ambil absensi dalam periode
  const [attendanceRows] = await safeAloraMobileQuery(`
    SELECT id, employee_id, attendance_date, attendance_mode, clock_in, clock_out, duration_hours,
           late_category, late_minutes, late_reason, late_status, is_late_waived, late_compensation_type,
           late_compensation_hours, clock_in_location_name, clock_out_location_name, punch_location_context_in
    FROM tr_worker_attendance
    WHERE employee_id IN (${placeholders})
      AND attendance_date >= ? AND attendance_date <= ?
    ORDER BY attendance_date ASC
  `, [...employeeIds, START_DATE, END_DATE]);

  // 3. Ambil cuti & perizinan disetujui
  const [leaveRows] = await safeAloraMobileQuery(`
    SELECT id, employee_id, leave_type, duration_type, start_date, end_date,
           leave_days, leave_duration_hours, funding_unpaid_hours, reason, status, doctor_note_file, doctor_note_path
    FROM tr_worker_leaves
    WHERE employee_id IN (${placeholders})
      AND status = 'disetujui'
      AND start_date <= ? AND end_date >= ?
  `, [...employeeIds, END_DATE, START_DATE]);

  // 4. Ambil lembur / replace off ledger earned
  const [lemburRows] = await safeAloraMobileQuery(`
    SELECT l.id, l.employee_id, l.hours, l.mutation_type,
           COALESCE(DATE(s.work_date), DATE(r.work_date), DATE(l.created_at)) AS work_date
    FROM tr_overtime_ledger l
    LEFT JOIN tr_attendance_sessions s ON s.id = l.session_id
    LEFT JOIN tr_worker_lembur_ro r ON r.id = l.lembur_ro_id
    WHERE l.employee_id IN (${placeholders})
      AND l.mutation_type = 'earned'
      AND COALESCE(DATE(s.work_date), DATE(r.work_date), DATE(l.created_at)) >= ?
      AND COALESCE(DATE(s.work_date), DATE(r.work_date), DATE(l.created_at)) <= ?
  `, [...employeeIds, START_DATE, END_DATE]);

  const allDates = getDatesInRange(START_DATE, END_DATE);

  // Map attendance per employee & date
  const attMap = new Map();
  for (const att of attendanceRows) {
    const key = `${att.employee_id}_${String(att.attendance_date).slice(0, 10)}`;
    attMap.set(key, att);
  }

  // Map lembur per employee & date
  const lemburMap = new Map();
  for (const lb of lemburRows) {
    const d = String(lb.work_date).slice(0, 10);
    const key = `${lb.employee_id}_${d}`;
    const curr = lemburMap.get(key) || 0;
    lemburMap.set(key, curr + Number(lb.hours || 0));
  }

  // Inisialisasi Workbook ExcelJS
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Alora SuperApp HR System";
  workbook.lastModifiedBy = "Alora HRIS";
  workbook.created = new Date();
  workbook.modified = new Date();

  // ==========================================
  // SHEET 1: RINGKASAN SEMUA KARYAWAN
  // ==========================================
  const summarySheet = workbook.addWorksheet("Ringkasan Semua Karyawan", {
    views: [{ state: "frozen", xSplit: 3, ySplit: 5 }],
  });

  // Title Banner (A1:W1)
  summarySheet.mergeCells("A1:W1");
  const titleCell = summarySheet.getCell("A1");
  titleCell.value = "REKAPITULASI ABSENSI & KINERJA KEHADIRAN KARYAWAN ALORA GROUP";
  titleCell.font = { name: "Calibri", size: 14, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E1B4B" } };
  titleCell.alignment = { horizontal: "center", vertical: "middle" };
  summarySheet.getRow(1).height = 34;

  // Subtitle Banner (A2:W2)
  summarySheet.mergeCells("A2:W2");
  const subCell = summarySheet.getCell("A2");
  subCell.value = `Periode Cutoff: ${PERIOD_LABEL}  |  Total Karyawan: ${employees.length} Orang  |  Dicetak pada: ${new Date().toLocaleString("id-ID")}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FFE0E7FF" } };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF312E81" } };
  subCell.alignment = { horizontal: "center", vertical: "middle" };
  summarySheet.getRow(2).height = 20;

  summarySheet.getRow(3).height = 8; // spacer

  // Table Headers (23 Kolom dengan Paid Days Tanpa Minggu & Paid Days + Minggu)
  const summaryHeaders = [
    "No",
    "NIK",
    "Nama Karyawan",
    "Departemen",
    "Jabatan",
    "Hari Kalender",
    "Hari Kerja Efektif",
    "Total Off (Minggu)",
    "Total Hadir (Office)",
    "WFA",
    "WOD",
    "Total Kehadiran",
    "Sakit",
    "Cuti Tahunan",
    "Izin / Khusus",
    "Alpha / Tanpa Ket.",
    "Paid Days (Tanpa Minggu)",
    "Paid Days (+ Minggu)",
    "Frekuensi Telat",
    "Durasi Telat (Menit)",
    "Durasi Telat (Jam)",
    "Telat Ditutup (RO/OT)",
    "Total Lembur (Jam)",
  ];

  const headerRow = summarySheet.getRow(4);
  summaryHeaders.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };

    // Highlight khusus untuk Paid Days Tanpa Minggu & Total Off
    if (h === "Paid Days (Tanpa Minggu)") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF065F46" } }; // Dark Emerald
    } else if (h === "Paid Days (+ Minggu)") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF047857" } }; // Medium Emerald
    } else if (h === "Total Off (Minggu)") {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } }; // Slate Gray
    } else {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4338CA" } }; // Indigo
    }

    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = borderAll("312E81");
  });
  headerRow.height = 32;

  // Track per-employee processed data for individual sheets
  const employeeDetails = [];

  employees.forEach((emp, eIdx) => {
    const empId = emp.employee_id;
    let countHadirOffice = 0;
    let countWfa = 0;
    let countWod = 0;
    let countSakit = 0;
    let countCuti = 0;
    let countIzin = 0;
    let countAlpha = 0;
    let countOff = 0;
    let unpaidLeaveDays = 0;
    let lateCount = 0;
    let lateMinutesTotal = 0;
    let lateWaivedCount = 0;
    let lemburHoursTotal = 0;
    let workHoursTotal = 0;

    const dailyRows = [];

    allDates.forEach((dObj, dIdx) => {
      const dateStr = dObj.dateStr;
      const att = attMap.get(`${empId}_${dateStr}`);
      const lemburHours = lemburMap.get(`${empId}_${dateStr}`) || 0;
      lemburHoursTotal += lemburHours;

      // Cek cuti / izin pada tanggal ini
      const empLeaves = leaveRows.filter(
        (l) => l.employee_id === empId && dateStr >= String(l.start_date).slice(0, 10) && dateStr <= String(l.end_date).slice(0, 10)
      );

      let statusHarian = "-";
      let modeLabel = "-";
      let clockInStr = "-";
      let clockOutStr = "-";
      let durasiKerjaStr = "-";
      let lateMinutes = 0;
      let lateKategori = "-";
      let lateAlasan = "-";
      let lateWaived = "-";
      let lokasiStr = "-";

      if (att && att.clock_in) {
        clockInStr = fmtTime(att.clock_in);
        clockOutStr = fmtTime(att.clock_out);
        durasiKerjaStr = att.duration_hours ? `${Number(att.duration_hours).toFixed(2)} jam` : "-";
        if (att.duration_hours) workHoursTotal += Number(att.duration_hours);

        const mode = String(att.attendance_mode || "regular").toLowerCase();
        if (mode === "wfa") {
          modeLabel = "WFA";
          countWfa++;
          statusHarian = "WFA";
        } else if (mode === "wod") {
          modeLabel = "WOD";
          countWod++;
          statusHarian = "WOD";
        } else {
          modeLabel = "Office";
          countHadirOffice++;
          statusHarian = "Hadir";
        }

        lokasiStr = att.punch_location_context_in === "office" ? "Office" : (att.clock_in_location_name || "Remote");

        // Evaluasi keterlambatan
        if (Number(att.late_minutes) > 0) {
          lateCount++;
          lateMinutes = Number(att.late_minutes);
          lateMinutesTotal += lateMinutes;
          lateKategori = att.late_category === "planned" ? "Terencana" : "Tidak Terencana";
          lateAlasan = att.late_reason || "-";
          if (statusHarian === "Hadir") statusHarian = "Hadir (Terlambat)";
          if (att.is_late_waived) {
            lateWaivedCount++;
            lateWaived = `Ditutup (${att.late_compensation_hours || 0}j ${att.late_compensation_type === "replace_off" ? "RO" : "OT"})`;
          }
        }
      } else if (empLeaves.length > 0) {
        const l = empLeaves[0];
        const lt = String(l.leave_type || "").toLowerCase();
        if (lt === "cuti") {
          countCuti++;
          statusHarian = "Cuti Tahunan";
        } else if (lt === "sakit") {
          countSakit++;
          const isSkd = Boolean(l.doctor_note_file || l.doctor_note_path);
          statusHarian = `Sakit (${isSkd ? "SKD" : "Non-SKD"})`;
        } else {
          countIzin++;
          const unpaidHours = Number(l.funding_unpaid_hours || 0);
          if (unpaidHours >= 7 || l.duration_type === "full_day") {
            unpaidLeaveDays += 1;
          } else if (unpaidHours > 0) {
            unpaidLeaveDays += Number((unpaidHours / 8).toFixed(2));
          }
          statusHarian = `Izin (${l.reason ? l.reason.slice(0, 20) : "Pribadi"})`;
        }
      } else if (!dObj.isWorkingDay) {
        statusHarian = "Libur (Off)";
        countOff++;
      } else {
        countAlpha++;
        statusHarian = "Alpha / Belum Absen";
      }

      dailyRows.push({
        no: dIdx + 1,
        dateStr,
        dayName: dObj.dayName,
        isWorkingDay: dObj.isWorkingDay,
        clockIn: clockInStr,
        clockOut: clockOutStr,
        duration: durasiKerjaStr,
        mode: modeLabel,
        location: lokasiStr,
        status: statusHarian,
        lateCategory: lateKategori,
        lateMinutes: lateMinutes > 0 ? lateMinutes : "-",
        lateHours: lateMinutes > 0 ? Number((lateMinutes / 60).toFixed(2)) : "-",
        lateWaived,
        lateReason: lateAlasan,
        lemburHours: lemburHours > 0 ? lemburHours : "-",
      });
    });

    const totalKehadiran = countHadirOffice + countWfa + countWod;
    const workingDaysCount = allDates.filter((d) => d.isWorkingDay).length; // 25 hari kerja efektif

    // Paid Days TANPA Minggu (Hanya hari kerja: Hadir + Cuti + Sakit + Izin dibayar, atau 25 - Alpha - Unpaid)
    const paidWorkingDays = Math.max(
      0,
      Math.round((countHadirOffice + countWfa + countWod + countSakit + countCuti + Math.max(0, countIzin - unpaidLeaveDays)) * 100) / 100
    );

    // Paid Days DENGAN Minggu (30 hari kalender - Alpha - Unpaid)
    const totalPaidDaysWithSunday = Math.max(0, Math.round((allDates.length - countAlpha - unpaidLeaveDays) * 100) / 100);

    employeeDetails.push({
      emp,
      stats: {
        totalDays: allDates.length,
        workingDaysCount,
        countOff,
        countHadirOffice,
        countWfa,
        countWod,
        totalKehadiran,
        countSakit,
        countCuti,
        countIzin,
        countAlpha,
        unpaidLeaveDays,
        paidWorkingDays,
        totalPaidDaysWithSunday,
        lateCount,
        lateMinutesTotal,
        lateHoursTotal: Number((lateMinutesTotal / 60).toFixed(2)),
        lateWaivedCount,
        lemburHoursTotal,
        workHoursTotal: Number(workHoursTotal.toFixed(2)),
      },
      dailyRows,
    });

    // Masukkan ke Sheet Ringkasan Semua Karyawan
    const rowIdx = 5 + eIdx;
    const sRow = summarySheet.getRow(rowIdx);
    const rowData = [
      eIdx + 1,
      emp.employee_code || "-",
      emp.full_name,
      emp.department_name || "-",
      emp.position_name || "-",
      allDates.length,
      workingDaysCount,
      countOff,
      countHadirOffice,
      countWfa,
      countWod,
      totalKehadiran,
      countSakit,
      countCuti,
      countIzin,
      countAlpha,
      paidWorkingDays,
      totalPaidDaysWithSunday,
      lateCount,
      lateMinutesTotal,
      Number((lateMinutesTotal / 60).toFixed(2)),
      lateWaivedCount > 0 ? `${lateWaivedCount}x Ditutup` : "-",
      lemburHoursTotal > 0 ? Number(lemburHoursTotal.toFixed(2)) : "-",
    ];

    rowData.forEach((val, cIdx) => {
      const cell = sRow.getCell(cIdx + 1);
      cell.value = val;
      cell.font = { name: "Calibri", size: 10 };
      cell.border = borderAll("E5E7EB");

      // Alignment & Styling per tipe kolom
      if (cIdx === 0 || cIdx === 1) {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      } else if (cIdx === 2 || cIdx === 3 || cIdx === 4) {
        cell.alignment = { horizontal: "left", vertical: "middle" };
      } else {
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }

      // Background alternating
      if (eIdx % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }

      // Highlight Paid Days Tanpa Minggu (Kolom 17)
      if (cIdx === 16) {
        cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: "FF065F46" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFECFDF5" } };
      }

      // Paid Days + Minggu (Kolom 18)
      if (cIdx === 17) {
        cell.font = { name: "Calibri", size: 10, color: { argb: "FF047857" } };
      }

      // Highlight Total Off (Kolom 8)
      if (cIdx === 7) {
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF334155" } };
      }

      // Highlight Alpha jika ada (Kolom 16)
      if (cIdx === 15 && countAlpha > 0) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
        cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF991B1B" } };
      }

      // Highlight Telat jika ada
      if ((cIdx === 18 || cIdx === 19 || cIdx === 20) && lateCount > 0) {
        cell.font = { name: "Calibri", size: 10, color: { argb: "FFB45309" } };
      }
    });
    sRow.height = 22;
  });

  // Set Column Widths untuk Sheet 1
  const summaryColWidths = [
    6, 14, 30, 20, 22, 14, 16, 16, 16, 10, 10, 16, 10, 14, 14, 16, 22, 18, 14, 18, 16, 18, 16,
  ];
  summaryColWidths.forEach((w, i) => {
    summarySheet.getColumn(i + 1).width = w;
  });

  // ==========================================
  // SHEET 2 S.D N: 1 SHEET PER KARYAWAN
  // ==========================================
  const usedSheetNames = new Set(["Ringkasan Semua Karyawan"]);

  employeeDetails.forEach((item, eIdx) => {
    const emp = item.emp;
    const stats = item.stats;

    // Bersihkan nama sheet (max 31 karakter, no special chars)
    let rawName = emp.full_name.replace(/[\\\/\?\*\[\]\:]/g, "").trim();
    let sheetName = rawName.slice(0, 31).trim();
    let counter = 1;
    while (usedSheetNames.has(sheetName)) {
      sheetName = `${rawName.slice(0, 27).trim()}_${counter}`;
      counter++;
    }
    usedSheetNames.add(sheetName);

    const sheet = workbook.addWorksheet(sheetName, {
      views: [{ state: "frozen", ySplit: 11 }],
    });

    // 1. Header Banner
    sheet.mergeCells("A1:P1");
    const h1 = sheet.getCell("A1");
    h1.value = "KARTU KEHADIRAN KARYAWAN — ALORA GROUP";
    h1.font = { name: "Calibri", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
    h1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E1B4B" } };
    h1.alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(1).height = 28;

    // 2. Info Karyawan
    sheet.mergeCells("A2:B2");
    sheet.getCell("A2").value = "Nama Karyawan";
    sheet.getCell("A2").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    sheet.mergeCells("C2:F2");
    sheet.getCell("C2").value = `: ${emp.full_name}`;
    sheet.getCell("C2").font = { name: "Calibri", size: 11, bold: true, color: { argb: "FF0F172A" } };

    sheet.mergeCells("H2:I2");
    sheet.getCell("H2").value = "Departemen";
    sheet.getCell("H2").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    sheet.mergeCells("J2:M2");
    sheet.getCell("J2").value = `: ${emp.department_name || "-"}`;
    sheet.getCell("J2").font = { name: "Calibri", size: 10, bold: true };

    sheet.mergeCells("A3:B3");
    sheet.getCell("A3").value = "NIK / Kode";
    sheet.getCell("A3").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    sheet.mergeCells("C3:F3");
    sheet.getCell("C3").value = `: ${emp.employee_code || "-"}`;
    sheet.getCell("C3").font = { name: "Calibri", size: 10 };

    sheet.mergeCells("H3:I3");
    sheet.getCell("H3").value = "Jabatan";
    sheet.getCell("H3").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    sheet.mergeCells("J3:M3");
    sheet.getCell("J3").value = `: ${emp.position_name || "-"}`;
    sheet.getCell("J3").font = { name: "Calibri", size: 10 };

    sheet.mergeCells("A4:B4");
    sheet.getCell("A4").value = "Periode Cutoff";
    sheet.getCell("A4").font = { name: "Calibri", size: 10, bold: true, color: { argb: "FF475569" } };
    sheet.mergeCells("C4:F4");
    sheet.getCell("C4").value = `: ${PERIOD_LABEL}`;
    sheet.getCell("C4").font = { name: "Calibri", size: 10, color: { argb: "FF4338CA" }, bold: true };

    sheet.getRow(2).height = 18;
    sheet.getRow(3).height = 18;
    sheet.getRow(4).height = 18;
    sheet.getRow(5).height = 8; // spacer

    // 3. Mini KPI Cards (Termasuk Paid Days Tanpa Minggu & Total Off)
    const kpiBoxes = [
      { label: "Paid Days (Tanpa Minggu)", val: `${stats.paidWorkingDays} / ${stats.workingDaysCount} Hari`, color: "065F46", bg: "ECFDF5", startCol: "A", endCol: "B" },
      { label: "Total Off (Minggu)", val: `${stats.countOff} Hari`, color: "334155", bg: "F1F5F9", startCol: "C", endCol: "D" },
      { label: "Total Kehadiran", val: `${stats.totalKehadiran} (${stats.countHadirOffice} Off / ${stats.countWfa} WFA)`, color: "1E40AF", bg: "EFF6FF", startCol: "E", endCol: "G" },
      { label: "Terlambat", val: `${stats.lateCount}x (${stats.lateHoursTotal} jam)`, color: "9A3412", bg: "FFF7ED", startCol: "H", endCol: "J" },
      { label: "Telat Ditutup", val: `${stats.lateWaivedCount}x Ditutup`, color: "5B21B6", bg: "F5F3FF", startCol: "K", endCol: "L" },
      { label: "Cuti / Izin / Sakit", val: `${stats.countCuti} / ${stats.countIzin} / ${stats.countSakit}`, color: "475569", bg: "F8FAFC", startCol: "M", endCol: "N" },
      { label: "Total Lembur", val: `${stats.lemburHoursTotal} jam`, color: "0284C7", bg: "F0F9FF", startCol: "O", endCol: "P" },
    ];

    kpiBoxes.forEach((kpi) => {
      sheet.mergeCells(`${kpi.startCol}6:${kpi.endCol}6`);
      const lCell = sheet.getCell(`${kpi.startCol}6`);
      lCell.value = kpi.label;
      lCell.font = { name: "Calibri", size: 9, bold: true, color: { argb: `FF${kpi.color}` } };
      lCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${kpi.bg}` } };
      lCell.alignment = { horizontal: "center", vertical: "middle" };
      lCell.border = borderAll(kpi.color);

      sheet.mergeCells(`${kpi.startCol}7:${kpi.endCol}7`);
      const vCell = sheet.getCell(`${kpi.startCol}7`);
      vCell.value = kpi.val;
      vCell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: `FF${kpi.color}` } };
      vCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${kpi.bg}` } };
      vCell.alignment = { horizontal: "center", vertical: "middle" };
      vCell.border = borderAll(kpi.color);
    });
    sheet.getRow(6).height = 16;
    sheet.getRow(7).height = 22;
    sheet.getRow(8).height = 8; // spacer

    // 4. Tabel Detail Harian
    const tableHeaders = [
      "No",
      "Tanggal",
      "Hari",
      "Status Hari",
      "Jam Masuk",
      "Jam Keluar",
      "Durasi Kerja",
      "Mode",
      "Lokasi",
      "Status Kehadiran",
      "Kategori Telat",
      "Telat (Menit)",
      "Telat (Jam)",
      "Kompensasi Telat",
      "Alasan Terlambat",
      "Lembur (Jam)",
    ];

    const dHeadRow = sheet.getRow(9);
    tableHeaders.forEach((h, idx) => {
      const c = dHeadRow.getCell(idx + 1);
      c.value = h;
      c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF312E81" } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = borderAll("1E1B4B");
    });
    dHeadRow.height = 26;

    // Isi Data 30 Hari
    item.dailyRows.forEach((r, dIdx) => {
      const rowNum = 10 + dIdx;
      const row = sheet.getRow(rowNum);
      const vals = [
        r.no,
        fmtDateIndo(r.dateStr),
        r.dayName,
        r.isWorkingDay ? "Hari Kerja" : "Libur Akhir Pekan",
        r.clockIn,
        r.clockOut,
        r.duration,
        r.mode,
        r.location,
        r.status,
        r.lateCategory,
        r.lateMinutes,
        r.lateHours,
        r.lateWaived,
        r.lateReason,
        r.lemburHours,
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = { name: "Calibri", size: 9.5 };
        cell.border = borderAll("E2E8F0");

        // Alignment
        if (cIdx === 0 || cIdx === 2 || cIdx === 3 || cIdx === 4 || cIdx === 5 || cIdx === 6 || cIdx === 7 || cIdx === 11 || cIdx === 12 || cIdx === 15) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
        } else if (cIdx === 1) {
          cell.alignment = { horizontal: "center", vertical: "middle" };
        } else {
          cell.alignment = { horizontal: "left", vertical: "middle" };
        }

        // Row highlighting based on day type / attendance
        if (!r.isWorkingDay) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
          cell.font = { name: "Calibri", size: 9.5, color: { argb: "FF94A3B8" } };
        } else if (r.status.includes("Terlambat")) {
          if (cIdx === 9 || cIdx === 10 || cIdx === 11 || cIdx === 12) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1F2" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF9F1239" } };
          }
        } else if (r.status.includes("WFA") || r.status.includes("WOD")) {
          if (cIdx === 9) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F3FF" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF5B21B6" } };
          }
        } else if (r.status.includes("Cuti") || r.status.includes("Izin") || r.status.includes("Sakit")) {
          if (cIdx === 9) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF6FF" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF1E40AF" } };
          }
        } else if (r.status.includes("Alpha")) {
          if (cIdx === 9) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
            cell.font = { name: "Calibri", size: 9.5, bold: true, color: { argb: "FF991B1B" } };
          }
        }
      });
      row.height = 20;
    });

    // Column widths for Employee Sheet
    const colWidths = [5, 18, 10, 16, 12, 12, 13, 10, 16, 20, 16, 13, 12, 22, 28, 14];
    colWidths.forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });
  });

  // Simpan File Excel
  const outputFileNameSpecific = "Rekap_Absensi_Per_Karyawan_Oktober_2026_PaidDays_Tanpa_Minggu.xlsx";
  const outputFileNameOriginal = "Rekap_Absensi_Per_Karyawan_Oktober_2026.xlsx";

  const targetSpecific = path.resolve("..", outputFileNameSpecific);
  const targetOriginal = path.resolve("..", outputFileNameOriginal);
  const targetArtifact = path.resolve(
    "C:\\Users\\PJ.ALORA3\\.gemini\\antigravity-ide\\brain\\bbae1857-5c07-4033-8d62-69933c9d7900",
    outputFileNameSpecific
  );

  // 1. Tulis file versi spesifik (Paid Days Tanpa Minggu)
  await workbook.xlsx.writeFile(targetSpecific);
  console.log(`[EXCEL GENERATOR] File versi spesifik berhasil disimpan di: ${targetSpecific}`);

  // 2. Coba update file original jika tidak sedang di-lock oleh Excel user
  try {
    await workbook.xlsx.writeFile(targetOriginal);
    console.log(`[EXCEL GENERATOR] File original berhasil diperbarui di: ${targetOriginal}`);
  } catch (lockErr) {
    console.warn(`[EXCEL GENERATOR] File original sedang dibuka di Excel (${lockErr.message}), file baru disimpan di: ${targetSpecific}`);
  }

  // 3. Simpan copy di artifact
  try {
    await workbook.xlsx.writeFile(targetArtifact);
    console.log(`[EXCEL GENERATOR] File copy berhasil disimpan di artifact: ${targetArtifact}`);
  } catch (err) {
    console.warn(`[EXCEL GENERATOR] Gagal simpan copy di artifact: ${err.message}`);
  }

  return { targetSpecific, targetOriginal, totalSheets: workbook.worksheets.length };
}

generateExcel()
  .then((res) => {
    console.log(`[EXCEL GENERATOR] Selesai! Total ${res.totalSheets} sheet berhasil dibuat.`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[EXCEL GENERATOR ERROR]:", err);
    process.exit(1);
  });
