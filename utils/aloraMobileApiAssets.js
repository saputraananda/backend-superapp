import path from "path";

/**
 * Alora Mobile API base, e.g. https://app.waschenalora.com/api
 */
export function getAloraMobileApiBaseUrl() {
	const raw = (process.env.ALORA_MOBILE_API_BASE_URL || "").trim().replace(/\/+$/, "");
	return raw || null;
}

/**
 * Shared guard secret — must match Alora Mobile SESSION_SECRET (prod: supersecretalora!)
 */
export function getAloraMobileFileSecret() {
	return (
		(process.env.ALORA_MOBILE_FILE_SECRET || "").trim() ||
		(process.env.ALORA_MOBILE_SESSION_SECRET || "").trim() ||
		""
	);
}

/**
 * Absolute Mobile file URL for server-side fetch (not for browser <img>).
 * @param {"leave"|"attendance"|"attendance-sessions"} kind
 */
export function buildAloraMobileApiFileUrl(kind, storedPathOrFile) {
	if (!storedPathOrFile) return null;
	if (/^https?:\/\//i.test(String(storedPathOrFile))) return String(storedPathOrFile);

	const name = path.basename(String(storedPathOrFile));
	if (!name || name === "." || name === "..") return null;

	const apiBase = getAloraMobileApiBaseUrl();
	if (!apiBase) return null;

	const encoded = encodeURIComponent(name);
	if (kind === "leave") return `${apiBase}/leave/doctor-notes/${encoded}`;
	if (kind === "attendance") return `${apiBase}/attendance/file/${encoded}`;
	if (kind === "attendance-sessions") return `${apiBase}/attendance-sessions/file/${encoded}`;
	return null;
}

/**
 * Proxy file from Alora Mobile API using shared secret.
 * @returns {Promise<boolean>} true if response already sent
 */
export async function proxyAloraMobileFile(kind, storedPathOrFile, res) {
	const url = buildAloraMobileApiFileUrl(kind, storedPathOrFile);
	const secret = getAloraMobileFileSecret();
	if (!url || !secret) return false;

	const upstream = await fetch(url, {
		headers: { "X-Alora-Mobile-Secret": secret },
	});

	if (upstream.status === 404) {
		res.status(404).json({ message: "File tidak ditemukan" });
		return true;
	}
	if (upstream.status === 401 || upstream.status === 403) {
		res.status(502).json({ message: "Secret Alora Mobile tidak cocok / akses ditolak" });
		return true;
	}
	if (!upstream.ok) {
		res.status(502).json({ message: "Gagal mengambil file dari Alora Mobile API" });
		return true;
	}

	const contentType = upstream.headers.get("content-type") || "application/octet-stream";
	res.setHeader("Content-Type", contentType);
	res.setHeader("Cache-Control", "private, max-age=300");
	const buf = Buffer.from(await upstream.arrayBuffer());
	res.send(buf);
	return true;
}
