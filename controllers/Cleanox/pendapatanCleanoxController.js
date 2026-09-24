import { safeCleanoxQuery } from "../../db/pool.js";
import {
	buildOmzetDateExpr,
	buildUnifiedOmzetWhere,
} from "./cleanoxOmzetUnified.js";

function fmtLocalDate(dt) {
	const y = dt.getFullYear();
	const m = String(dt.getMonth() + 1).padStart(2, "0");
	const dd = String(dt.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

/** Cutoff 26→25 from asOfDate (YYYY-MM-DD). */
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
	return { dateStart: fmtLocalDate(dateStart), dateEnd: fmtLocalDate(dateEnd) };
}

/** Yesterday Asia/Jakarta — konsisten dengan cutoff bisnis. */
function yesterdayJakartaISO() {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Jakarta",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const get = (t) => parts.find((p) => p.type === t)?.value;
	const y = Number(get("year"));
	const m = Number(get("month"));
	const d = Number(get("day"));
	const local = new Date(y, m - 1, d);
	local.setDate(local.getDate() - 1);
	return fmtLocalDate(local);
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

/**
 * GET /cleanox/pendapatan
 * Omzet lunas POS + Smartlink (v_transactions_unified) vs mst_target_cleanox.
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
				asOfDate = yesterdayJakartaISO();
			}
			effectiveAsOfDate = asOfDate;
			({ dateStart, dateEnd } = computeDateRange(asOfDate));
		}

		{
			const yesterday = yesterdayJakartaISO();
			if (effectiveAsOfDate > yesterday) effectiveAsOfDate = yesterday;
			if (effectiveAsOfDate < dateStart) effectiveAsOfDate = dateStart;
		}

		const omzetExpr = buildOmzetDateExpr("v");
		const whereOmzet = buildUnifiedOmzetWhere({
			serviceMode,
			dateStart,
			dateEnd: effectiveAsOfDate,
			alias: "v",
		});

		const [actualRows] = await safeCleanoxQuery(
			`SELECT COALESCE(SUM(v.final_amount), 0) AS actual_sales
       FROM v_transactions_unified v
       WHERE ${whereOmzet.sql}`,
			whereOmzet.params,
		);
		const cleanoxActual = toNum(actualRows?.[0]?.actual_sales);

		const [trendRows] = await safeCleanoxQuery(
			`SELECT DATE_FORMAT((${omzetExpr}), '%Y-%m-%d') AS date,
              COALESCE(SUM(v.final_amount), 0) AS sales
       FROM v_transactions_unified v
       WHERE ${whereOmzet.sql}
       GROUP BY DATE_FORMAT((${omzetExpr}), '%Y-%m-%d')
       ORDER BY date ASC`,
			whereOmzet.params,
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
				sources: ["pos", "smartlink"],
			},
		});
	} catch (err) {
		console.error("[getPendapatanCleanox]", err);
		return res.status(500).json({ message: err.message || "Gagal memuat pendapatan Cleanox" });
	}
}
