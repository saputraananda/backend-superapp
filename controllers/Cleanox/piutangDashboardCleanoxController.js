import { safeCleanoxQuery } from "../../db/pool.js";

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
        END AS aging
      FROM tr_transactions t
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
		}));

		const total = list.reduce((a, r) => a + r.piutang, 0);
		const jatuhTempo = list
			.filter((r) => r.status === "Jatuh Tempo")
			.reduce((a, r) => a + r.piutang, 0);
		const terlambat = list
			.filter((r) => r.status === "Terlambat")
			.reduce((a, r) => a + r.piutang, 0);

		const filterLabel = serviceModeLabel(serviceMode);
		const perOutlet = [{ outlet: filterLabel, total }];

		return res.json({
			piutang: list,
			summary: { total, jatuh_tempo: jatuhTempo, terlambat },
			per_outlet: perOutlet,
			meta: { dateStart, dateEnd, service_mode: serviceMode },
		});
	} catch (err) {
		console.error("[getPiutangDashboardCleanox]", err);
		return res.status(500).json({ message: err.message || "Gagal memuat piutang Cleanox" });
	}
}
