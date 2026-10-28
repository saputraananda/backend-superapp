import { safeCleanoxQuery } from "../../db/pool.js";

let tableEnsured = false;
async function ensurePiutangReminderTable() {
	if (tableEnsured) return;
	try {
		await safeCleanoxQuery(`
			CREATE TABLE IF NOT EXISTS tr_piutang_reminders (
				id INT AUTO_INCREMENT PRIMARY KEY,
				no_nota VARCHAR(100) NOT NULL,
				customer_phone VARCHAR(50) NOT NULL,
				customer_name VARCHAR(150),
				amount DECIMAL(15,2) DEFAULT 0,
				channel VARCHAR(50) DEFAULT 'WhatsApp',
				reminded_at DATETIME NOT NULL,
				reminded_by VARCHAR(100) DEFAULT 'CS Cleanox',
				notes TEXT,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				INDEX idx_nota (no_nota),
				INDEX idx_phone (customer_phone)
			) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
		`);
		tableEnsured = true;
	} catch (err) {
		console.error("[ensurePiutangReminderTable Error]:", err);
	}
}

function computeDateRange(asOfDate) {
	const d = new Date(asOfDate + "T12:00:00");
	const day = d.getDate();
	let dateStart, dateEnd;
	if (day >= 26) {
		dateStart = new Date(d.getFullYear(), d.getMonth(), 26);
		dateEnd = new Date(d.getFullYear(), d.getMonth() + 1, 25);
	} else {
		dateStart = new Date(d.getFullYear(), d.getMonth() - 1, 26);
		dateEnd = new Date(d.getFullYear(), d.getMonth(), 25);
	}
	const fmt = (dt) => {
		const y = dt.getFullYear();
		const m = String(dt.getMonth() + 1).padStart(2, "0");
		const dd = String(dt.getDate()).padStart(2, "0");
		return `${y}-${m}-${dd}`;
	};
	return { dateStart: fmt(dateStart), dateEnd: fmt(dateEnd) };
}

function toNum(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

function normalizeServiceMode(raw) {
	const mode = String(raw || "all").trim().toLowerCase();
	if (mode === "home_service" || mode === "take_home") return mode;
	return "all";
}

function serviceModeLabel(mode) {
	if (mode === "home_service") return "Home Service";
	if (mode === "take_home") return "Take Home";
	return "Semua Layanan";
}

function rowServiceModeLabel(raw) {
	return String(raw || "home_service") === "take_home" ? "Take Home" : "Home Service";
}

function buildServiceModeClause(mode, alias = "t") {
	if (mode === "take_home") {
		return { sql: ` AND ${alias}.service_mode = 'take_home'`, params: [] };
	}
	if (mode === "home_service") {
		return {
			sql: ` AND (${alias}.service_mode = 'home_service' OR ${alias}.service_mode IS NULL OR ${alias}.service_mode = '')`,
			params: [],
		};
	}
	return { sql: "", params: [] };
}

/**
 * GET /cleanox/piutang-dashboard
 */
export async function getPiutangDashboardCleanox(req, res) {
	try {
		await ensurePiutangReminderTable();
		const dateRe = /^\d{4}-\d{2}-\d{2}$/;
		let { asOfDate, startDate, endDate } = req.query;
		const serviceMode = normalizeServiceMode(req.query.service_mode);

		if (asOfDate && !dateRe.test(asOfDate)) {
			return res.status(400).json({ message: "Format asOfDate harus YYYY-MM-DD" });
		}
		if (startDate && !dateRe.test(startDate)) {
			return res.status(400).json({ message: "Format startDate harus YYYY-MM-DD" });
		}
		if (endDate && !dateRe.test(endDate)) {
			return res.status(400).json({ message: "Format endDate harus YYYY-MM-DD" });
		}

		const isRange = !!(startDate && endDate);
		let dateStart, dateEnd;
		if (isRange) {
			dateStart = startDate;
			dateEnd = endDate;
		} else {
			if (!asOfDate) {
				const y = new Date();
				y.setDate(y.getDate() - 1);
				const yy = y.getFullYear();
				const mm = String(y.getMonth() + 1).padStart(2, "0");
				const dd = String(y.getDate()).padStart(2, "0");
				asOfDate = `${yy}-${mm}-${dd}`;
			}
			({ dateStart, dateEnd } = computeDateRange(asOfDate));
		}

		const modeClause = buildServiceModeClause(serviceMode, "t");

		const sql = `
      SELECT
        t.service_mode,
        t.customer_name AS customer_nama,
        t.customer_phone AS customer_telepon,
        t.transaction_no AS no_nota,
        DATE_FORMAT(DATE(t.service_date), '%Y-%m-%d') AS tgl_terima,
        DATE_FORMAT(DATE(t.service_date), '%Y-%m-%d') AS tgl_selesai,
        COALESCE(t.final_amount, 0) AS piutang,
        CASE
          WHEN DATE(t.service_date) < CURDATE() THEN 'Terlambat'
          WHEN DATE(t.service_date) = CURDATE() THEN 'Jatuh Tempo'
          ELSE 'Belum Jatuh Tempo'
        END AS status,
        CASE
          WHEN DATE(t.service_date) > CURDATE() THEN 0
          ELSE DATEDIFF(CURDATE(), DATE(t.service_date))
        END AS aging,
        rem.last_reminded_at,
        rem.last_reminded_by,
        rem.last_channel,
        rem.reminder_count
      FROM tr_transactions t
      LEFT JOIN (
        SELECT
          no_nota,
          MAX(reminded_at) AS last_reminded_at,
          SUBSTRING_INDEX(GROUP_CONCAT(reminded_by ORDER BY reminded_at DESC SEPARATOR '|||'), '|||', 1) AS last_reminded_by,
          SUBSTRING_INDEX(GROUP_CONCAT(channel ORDER BY reminded_at DESC SEPARATOR '|||'), '|||', 1) AS last_channel,
          COUNT(*) AS reminder_count
        FROM tr_piutang_reminders
        GROUP BY no_nota
      ) rem ON rem.no_nota = t.transaction_no
      WHERE DATE(t.service_date) >= ?
        AND DATE(t.service_date) <= ?
        AND t.status <> 'Cancelled'
        AND (t.payment_status = 'belum_lunas' OR t.payment_status IS NULL OR t.payment_status = '')
        ${modeClause.sql}
      ORDER BY DATE(t.service_date) ASC, t.customer_name ASC, t.transaction_no ASC
    `;

		const [rows] = await safeCleanoxQuery(sql, [dateStart, dateEnd, ...modeClause.params]);

		const list = (rows || []).map((r) => ({
			outlet: rowServiceModeLabel(r.service_mode),
			customer_nama: r.customer_nama || "",
			customer_telepon: r.customer_telepon || "",
			no_nota: r.no_nota || "",
			tgl_terima: String(r.tgl_terima || "").slice(0, 10),
			tgl_selesai: String(r.tgl_selesai || "").slice(0, 10),
			piutang: toNum(r.piutang),
			status: r.status,
			aging: toNum(r.aging),
			is_reminded: Boolean(r.last_reminded_at),
			reminded_at: r.last_reminded_at ? new Date(r.last_reminded_at).toISOString() : null,
			reminded_by: r.last_reminded_by || null,
			reminder_channel: r.last_channel || null,
			reminder_count: Number(r.reminder_count || 0),
		}));

		const total = list.reduce((a, r) => a + r.piutang, 0);
		const jatuhTempo = list
			.filter((r) => r.status === "Jatuh Tempo")
			.reduce((a, r) => a + r.piutang, 0);
		const terlambat = list
			.filter((r) => r.status === "Terlambat")
			.reduce((a, r) => a + r.piutang, 0);

		const remindedCount = list.filter((r) => r.is_reminded).length;
		const unremindedCount = list.length - remindedCount;

		const filterLabel = serviceModeLabel(serviceMode);
		const perOutlet = [{ outlet: filterLabel, total }];

		return res.json({
			piutang: list,
			summary: {
				total,
				jatuh_tempo: jatuhTempo,
				terlambat,
				reminded_count: remindedCount,
				unreminded_count: unremindedCount,
			},
			per_outlet: perOutlet,
			meta: { dateStart, dateEnd, service_mode: serviceMode },
		});
	} catch (err) {
		console.error("[getPiutangDashboardCleanox]", err);
		return res.status(500).json({ message: err.message || "Gagal memuat piutang Cleanox" });
	}
}

/**
 * POST /cleanox/piutang-dashboard/remind
 */
export async function recordPiutangReminder(req, res) {
	try {
		await ensurePiutangReminderTable();
		const {
			no_nota = "",
			customer_phone = "",
			customer_name = "",
			amount = 0,
			channel = "WhatsApp",
			notes = "",
		} = req.body;

		if (!no_nota) {
			return res.status(400).json({ success: false, message: "no_nota wajib diisi" });
		}

		const reminded_by = req.user?.name || req.body.reminded_by || "CS Cleanox";

		await safeCleanoxQuery(
			`INSERT INTO tr_piutang_reminders
        (no_nota, customer_phone, customer_name, amount, channel, reminded_at, reminded_by, notes)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)`,
			[no_nota, customer_phone, customer_name, Number(amount) || 0, channel, reminded_by, notes],
		);

		return res.json({
			success: true,
			message: "Reminder piutang berhasil dicatat",
			data: {
				no_nota,
				customer_phone,
				customer_name,
				reminded_at: new Date().toISOString(),
				reminded_by,
			},
		});
	} catch (err) {
		console.error("[recordPiutangReminder Error]:", err);
		return res.status(500).json({ success: false, message: "Gagal mencatat reminder piutang" });
	}
}

/**
 * POST /cleanox/piutang-dashboard/unremind
 */
export async function cancelPiutangReminder(req, res) {
	try {
		await ensurePiutangReminderTable();
		const { no_nota = "" } = req.body;

		if (!no_nota) {
			return res.status(400).json({ success: false, message: "no_nota wajib diisi" });
		}

		await safeCleanoxQuery(`DELETE FROM tr_piutang_reminders WHERE no_nota = ?`, [no_nota]);

		return res.json({ success: true, message: "Status reminder piutang berhasil direset" });
	} catch (err) {
		console.error("[cancelPiutangReminder Error]:", err);
		return res.status(500).json({ success: false, message: "Gagal mereset status reminder piutang" });
	}
}
