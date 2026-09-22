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

function daysBetweenInclusive(startStr, endStr) {
	const a = new Date(startStr + "T12:00:00");
	const b = new Date(endStr + "T12:00:00");
	return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function normalizeServiceMode(raw) {
	const mode = String(raw || "all").trim().toLowerCase();
	if (mode === "home_service" || mode === "take_home") return mode;
	return "all";
}

/** @returns {{ sql: string, params: any[] }} */
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
 * GET /cleanox/pendapatan
 * POS lunas vs mst_target_cleanox — omzet by payment_settled_date; filter by service_mode.
 */
export async function getPendapatanCleanox(req, res) {
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
		let effectiveAsOfDate, dateStart, dateEnd;
		if (isRange) {
			effectiveAsOfDate = endDate;
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
			effectiveAsOfDate = asOfDate;
			({ dateStart, dateEnd } = computeDateRange(asOfDate));
		}

		{
			const y = new Date();
			y.setDate(y.getDate() - 1);
			const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
			if (effectiveAsOfDate > yesterday) effectiveAsOfDate = yesterday;
			if (effectiveAsOfDate < dateStart) effectiveAsOfDate = dateStart;
		}

		const modeClause = buildServiceModeClause(serviceMode, "t");

		const [actualRows] = await safeCleanoxQuery(
			`SELECT COALESCE(SUM(t.final_amount), 0) AS actual_sales
       FROM tr_transactions t
       WHERE t.payment_settled_date IS NOT NULL
         AND t.payment_settled_date >= ?
         AND t.payment_settled_date <= ?
         AND t.payment_status = 'lunas'
         AND t.status <> 'Cancelled'
         ${modeClause.sql}`,
			[dateStart, effectiveAsOfDate, ...modeClause.params],
		);
		const cleanoxActual = toNum(actualRows?.[0]?.actual_sales);

		const [trendRows] = await safeCleanoxQuery(
			`SELECT DATE_FORMAT(t.payment_settled_date, '%Y-%m-%d') AS date,
              COALESCE(SUM(t.final_amount), 0) AS sales
       FROM tr_transactions t
       WHERE t.payment_settled_date IS NOT NULL
         AND t.payment_settled_date >= ?
         AND t.payment_settled_date <= ?
         AND t.payment_status = 'lunas'
         AND t.status <> 'Cancelled'
         ${modeClause.sql}
       GROUP BY DATE_FORMAT(t.payment_settled_date, '%Y-%m-%d')
       ORDER BY date ASC`,
			[dateStart, effectiveAsOfDate, ...modeClause.params],
		);
		const trend = (trendRows || []).map((r) => ({
			date: String(r.date).slice(0, 10),
			sales: toNum(r.sales),
		}));

		const endDt = new Date(dateEnd + "T12:00:00");
		const targetTahun = endDt.getFullYear();
		const targetBulan = endDt.getMonth() + 1;

		const [targetRows] = await safeCleanoxQuery(
			`SELECT COALESCE(SUM(nominal), 0) AS nominal
       FROM mst_target_cleanox
       WHERE tahun = ? AND bulan = ?`,
			[targetTahun, targetBulan],
		);
		const companyTarget = toNum(targetRows?.[0]?.nominal);

		const totalDay = daysBetweenInclusive(dateStart, dateEnd);
		const dateCount = daysBetweenInclusive(dateStart, effectiveAsOfDate);
		const persenKumulatif = totalDay > 0 ? Math.round((dateCount / totalDay) * 10000) / 100 : 0;
		const targetKumulatif = (dateCount / totalDay) * companyTarget;

		const outletsOut = [
			{
				outlet: "Cleanox",
				target_bulanan: companyTarget,
				persen_target_kumulatif: persenKumulatif,
				target_kumulatif_sales: targetKumulatif,
				actual_sales: cleanoxActual,
				gap_nominal: cleanoxActual - targetKumulatif,
			},
		];

		return res.json({
			outlets: outletsOut,
			trend,
			meta: {
				asOfDate: effectiveAsOfDate,
				dateStart,
				dateEnd,
				service_mode: serviceMode,
			},
		});
	} catch (err) {
		console.error("[getPendapatanCleanox]", err);
		return res.status(500).json({ message: err.message || "Gagal memuat pendapatan Cleanox" });
	}
}
