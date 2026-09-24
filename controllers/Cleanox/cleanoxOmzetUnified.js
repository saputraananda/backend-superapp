/**
 * Shared omzet date / filter helpers for Cleanox Pendapatan + Riwayat unified (POS + Smartlink).
 */

export function buildOmzetDateExpr(alias = "v") {
	const a = alias;
	return `CASE
    WHEN ${a}.source_system = 'smartlink' THEN DATE(${a}.service_date)
    ELSE COALESCE(${a}.payment_settled_date, DATE(${a}.service_date))
  END`;
}

/** POS table only (no source_system column). */
export function buildPosOmzetDateExpr(alias = "t") {
	const a = alias;
	return `COALESCE(${a}.payment_settled_date, DATE(${a}.service_date))`;
}

/**
 * @param {{ serviceMode?: string, dateStart: string, dateEnd: string, alias?: string }} opts
 * @returns {{ sql: string, params: any[] }}
 */
export function buildUnifiedOmzetWhere({
	serviceMode = "all",
	dateStart,
	dateEnd,
	alias = "v",
} = {}) {
	const a = alias;
	const omzet = buildOmzetDateExpr(a);
	const params = [dateStart, dateEnd];
	let sql = `
    (${omzet}) >= ?
    AND (${omzet}) <= ?
    AND ${a}.payment_status = 'lunas'
    AND (
      ${a}.source_system = 'smartlink'
      OR (${a}.source_system = 'pos' AND ${a}.status <> 'Cancelled')
    )`;

	const mode = String(serviceMode || "all").trim().toLowerCase();
	if (mode === "take_home") {
		sql += ` AND ${a}.source_system = 'pos' AND ${a}.service_mode = 'take_home'`;
	} else if (mode === "home_service") {
		sql += ` AND ${a}.source_system = 'pos'
      AND (${a}.service_mode = 'home_service' OR ${a}.service_mode IS NULL OR ${a}.service_mode = '')`;
	}

	return { sql, params };
}

export function mapKategori(group) {
	const g = String(group || "").trim();
	if (!g) return "-";
	return g.toUpperCase();
}

export function mapKategoriUnified(group, sourceSystem) {
	if (String(sourceSystem || "").toLowerCase() === "smartlink") {
		return "SMARTLINK";
	}
	return mapKategori(group);
}

export function isTunaiKategori(kategori) {
	return String(kategori || "")
		.trim()
		.toUpperCase() === "TUNAI";
}

/** API summary non_tunai: POS bank methods; exclude SMARTLINK / COLLABORATION / TUNAI / empty. */
export function isNonTunaiSummaryKategori(kategori) {
	const k = String(kategori || "")
		.trim()
		.toUpperCase();
	if (!k || k === "-" || isTunaiKategori(k)) return false;
	if (k === "SMARTLINK" || k === "COLLABORATION") return false;
	return true;
}

/** Excel rekonsiliasi NON TUNAI: all non-tunai including SMARTLINK; exclude COLLABORATION. */
export function isNonTunaiReconKategori(kategori) {
	const k = String(kategori || "")
		.trim()
		.toUpperCase();
	if (!k || k === "-" || isTunaiKategori(k)) return false;
	if (k === "COLLABORATION") return false;
	return true;
}
