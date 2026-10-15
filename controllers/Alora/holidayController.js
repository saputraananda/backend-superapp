import { safeAloraMobileQuery } from "../../db/pool.js";
import { pool } from "../../db/pool.js";

const MONTH_NAMES = [
	"Januari", "Februari", "Maret", "April", "Mei", "Juni",
	"Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

async function getSessionEmployee(req) {
	const userId = req.session?.userId;
	if (!userId) return null;
	const [[emp]] = await pool.query(
		`SELECT e.employee_id, e.full_name
		 FROM mst_employee e
		 JOIN users u ON u.id = e.employee_id
		 WHERE u.id = ? AND e.exit_date IS NULL LIMIT 1`,
		[userId]
	);
	return emp || null;
}

export function computeCutoffPeriod(month, year, additionalHolidayDays = 0, notes = "") {
	const m = Number(month);
	const y = Number(year);
	const prevMonth = m === 1 ? 12 : m - 1;
	const prevYear = m === 1 ? y - 1 : y;
	const startStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}-26`;
	const endStr = `${y}-${String(m).padStart(2, "0")}-25`;

	let totalDays = 0;
	let sundayDays = 0;

	let d = new Date(`${startStr}T12:00:00+07:00`);
	const end = new Date(`${endStr}T12:00:00+07:00`);

	while (d <= end) {
		totalDays++;
		if (d.getUTCDay() === 0) {
			sundayDays++;
		}
		d.setUTCDate(d.getUTCDate() + 1);
	}

	const addHolidays = Math.max(0, Number(additionalHolidayDays) || 0);
	const workDays = Math.max(0, totalDays - sundayDays - addHolidays);

	return {
		cutoff_month: m,
		cutoff_year: y,
		month_name: MONTH_NAMES[m - 1],
		period_start: startStr,
		period_end: endStr,
		label: `${MONTH_NAMES[m - 1]} ${y}`,
		period_range_label: `26 ${MONTH_NAMES[prevMonth - 1].slice(0, 3)} - 25 ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`,
		total_days: totalDays,
		sunday_days: sundayDays,
		additional_holiday_days: addHolidays,
		total_holidays: sundayDays + addHolidays,
		work_days: workDays,
		notes: notes || ""
	};
}

// ── GET /alora/holidays/cutoff?year=YYYY — ambil 12 bulan cut-off ──────────────
export async function listCutoffHolidays(req, res) {
	try {
		const year = Number(req.query.year) || new Date().getFullYear();

		const [savedRows] = await safeAloraMobileQuery(
			`SELECT cutoff_month, cutoff_year, additional_holiday_days, notes
			 FROM mst_cutoff_holiday
			 WHERE cutoff_year = ?
			 ORDER BY cutoff_month ASC`,
			[year]
		);

		const savedMap = new Map();
		for (const row of savedRows) {
			savedMap.set(Number(row.cutoff_month), row);
		}

		const cutoffs = [];
		for (let m = 1; m <= 12; m++) {
			const saved = savedMap.get(m);
			const addHolidays = saved ? Number(saved.additional_holiday_days || 0) : 0;
			const notes = saved ? saved.notes || "" : "";
			cutoffs.push(computeCutoffPeriod(m, year, addHolidays, notes));
		}

		return res.json({ success: true, year, cutoffs });
	} catch (err) {
		console.error("[holiday] listCutoffHolidays:", err);
		return res.status(500).json({ message: "Gagal memuat data cut-off hari libur" });
	}
}

// ── POST /alora/holidays/cutoff — simpan / update libur cut-off ─────────────────
export async function saveCutoffHoliday(req, res) {
	try {
		const emp = await getSessionEmployee(req);
		if (!emp) return res.status(401).json({ message: "Unauthorized" });

		const { cutoff_month, cutoff_year, additional_holiday_days, notes } = req.body;
		const m = Number(cutoff_month);
		const y = Number(cutoff_year);
		const days = Math.max(0, parseInt(additional_holiday_days, 10) || 0);
		const noteClean = typeof notes === "string" ? notes.trim() : "";

		if (!m || m < 1 || m > 12) {
			return res.status(400).json({ message: "Bulan cut-off tidak valid (1-12)" });
		}
		if (!y || y < 2000) {
			return res.status(400).json({ message: "Tahun cut-off tidak valid" });
		}

		await safeAloraMobileQuery(
			`INSERT INTO mst_cutoff_holiday (cutoff_month, cutoff_year, additional_holiday_days, notes)
			 VALUES (?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE
			   additional_holiday_days = VALUES(additional_holiday_days),
			   notes = VALUES(notes)`,
			[m, y, days, noteClean || null]
		);

		const updated = computeCutoffPeriod(m, y, days, noteClean);
		return res.json({
			success: true,
			message: `Hari libur cut-off ${updated.label} berhasil disimpan`,
			cutoff: updated
		});
	} catch (err) {
		console.error("[holiday] saveCutoffHoliday:", err);
		return res.status(500).json({ message: "Gagal menyimpan hari libur cut-off" });
	}
}

// ── GET /alora/holidays?year=YYYY — ambil semua hari libur kalender (fallback) ─
export async function listHolidays(req, res) {
	try {
		const year = Number(req.query.year) || new Date().getFullYear();
		const [rows] = await safeAloraMobileQuery(
			`SELECT id, holiday_date, name, holiday_type
			 FROM mst_holiday
			 WHERE YEAR(holiday_date) = ?
			 ORDER BY holiday_date ASC`,
			[year]
		);
		return res.json({ success: true, holidays: rows });
	} catch (err) {
		console.error("[holiday] listHolidays:", err);
		return res.status(500).json({ message: "Gagal memuat data hari libur" });
	}
}

// ── GET /alora/holidays/years — ambil list tahun yang ada ─────────────────────
export async function listHolidayYears(req, res) {
	try {
		const [rows] = await safeAloraMobileQuery(
			`SELECT DISTINCT cutoff_year AS year FROM mst_cutoff_holiday
			 UNION
			 SELECT DISTINCT YEAR(holiday_date) AS year FROM mst_holiday
			 ORDER BY year DESC`
		);
		const currentYear = new Date().getFullYear();
		const years = rows.map((r) => r.year).filter(Boolean);
		if (!years.includes(currentYear - 1)) years.push(currentYear - 1);
		if (!years.includes(currentYear)) years.push(currentYear);
		if (!years.includes(currentYear + 1)) years.push(currentYear + 1);
		return res.json({ success: true, years: [...new Set(years)].sort((a, b) => b - a) });
	} catch (err) {
		console.error("[holiday] listYears:", err);
		return res.status(500).json({ message: "Gagal memuat tahun hari libur" });
	}
}

// ── POST /alora/holidays — tambah hari libur kalender ─────────────────────────
export async function createHoliday(req, res) {
	try {
		const emp = await getSessionEmployee(req);
		if (!emp) return res.status(401).json({ message: "Unauthorized" });

		const { holiday_date, name, holiday_type = "national" } = req.body;
		if (!holiday_date) return res.status(400).json({ message: "Tanggal hari libur wajib diisi" });
		if (!name?.trim()) return res.status(400).json({ message: "Nama hari libur wajib diisi" });

		const [existing] = await safeAloraMobileQuery(
			`SELECT id FROM mst_holiday WHERE holiday_date = ? LIMIT 1`,
			[holiday_date]
		);
		if (existing.length > 0) {
			return res.status(409).json({ message: `Tanggal ${holiday_date} sudah terdaftar sebagai hari libur` });
		}

		await safeAloraMobileQuery(
			`INSERT INTO mst_holiday (holiday_date, name, holiday_type) VALUES (?, ?, ?)`,
			[holiday_date, name.trim(), holiday_type]
		);

		return res.status(201).json({ success: true, message: "Hari libur berhasil ditambahkan" });
	} catch (err) {
		console.error("[holiday] create:", err);
		return res.status(500).json({ message: "Gagal menambahkan hari libur" });
	}
}

// ── PATCH /alora/holidays/:id — edit hari libur kalender ──────────────────────
export async function updateHoliday(req, res) {
	try {
		const emp = await getSessionEmployee(req);
		if (!emp) return res.status(401).json({ message: "Unauthorized" });

		const { id } = req.params;
		const { holiday_date, name, holiday_type } = req.body;

		await safeAloraMobileQuery(
			`UPDATE mst_holiday SET
			   holiday_date = COALESCE(?, holiday_date),
			   name         = COALESCE(?, name),
			   holiday_type = COALESCE(?, holiday_type)
			 WHERE id = ?`,
			[holiday_date || null, name?.trim() || null, holiday_type || null, id]
		);

		return res.json({ success: true, message: "Hari libur diperbarui" });
	} catch (err) {
		console.error("[holiday] update:", err);
		return res.status(500).json({ message: "Gagal memperbarui hari libur" });
	}
}

// ── DELETE /alora/holidays/:id — hapus hari libur kalender ───────────────────
export async function deleteHoliday(req, res) {
	try {
		const emp = await getSessionEmployee(req);
		if (!emp) return res.status(401).json({ message: "Unauthorized" });

		const { id } = req.params;
		await safeAloraMobileQuery(`DELETE FROM mst_holiday WHERE id = ?`, [id]);
		return res.json({ success: true, message: "Hari libur dihapus" });
	} catch (err) {
		console.error("[holiday] delete:", err);
		return res.status(500).json({ message: "Gagal menghapus hari libur" });
	}
}
