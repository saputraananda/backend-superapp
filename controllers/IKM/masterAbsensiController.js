import { safeIKMQuery } from "../../db/pool.js";

// ─── Validation helpers ────────────────────────────────────────────────────

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

function sanitizeTimeInput(value) {
	const str = String(value || "").trim();
	if (!TIME_REGEX.test(str)) return null;
	// Normalize to HH:MM:SS
	const parts = str.split(":");
	const h = parts[0].padStart(2, "0");
	const m = parts[1].padStart(2, "0");
	const s = parts[2] ? parts[2].padStart(2, "0") : "00";
	return `${h}:${m}:${s}`;
}

function sanitizeShiftName(value) {
	const str = String(value || "").trim();
	if (!str || str.length > 50) return null;
	return str;
}

function toBoolean(value) {
	if (typeof value === "boolean") return value;
	return ["1", "true", "yes", "y"].includes(String(value ?? "").toLowerCase());
}

function toPositiveInt(value) {
	const n = Number(value);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function validateShiftBody(body) {
	const shift_name = sanitizeShiftName(body.shift_name);
	const check_in_start = sanitizeTimeInput(body.check_in_start);
	const check_in_end = sanitizeTimeInput(body.check_in_end);
	const check_out_start = sanitizeTimeInput(body.check_out_start);
	const check_out_end = sanitizeTimeInput(body.check_out_end);
	const is_overnight = toBoolean(body.is_overnight) ? 1 : 0;

	const errors = [];
	if (!shift_name) errors.push("shift_name harus diisi dan maksimal 50 karakter");
	if (!check_in_start) errors.push("check_in_start harus berformat HH:MM atau HH:MM:SS");
	if (!check_in_end) errors.push("check_in_end harus berformat HH:MM atau HH:MM:SS");
	if (!check_out_start) errors.push("check_out_start harus berformat HH:MM atau HH:MM:SS");
	if (!check_out_end) errors.push("check_out_end harus berformat HH:MM atau HH:MM:SS");

	if (errors.length) return { valid: false, errors };
	return { valid: true, data: { shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight } };
}

// ─── Shift Normal CRUD ─────────────────────────────────────────────────────

export const getShiftsNormal = async (req, res) => {
	try {
		const [rows] = await safeIKMQuery(
			"SELECT id, shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight, created_at, updated_at FROM mst_shift_normal ORDER BY id ASC",
			[],
		);
		res.json({ data: rows });
	} catch (error) {
		console.error("[masterAbsensi] getShiftsNormal error:", error);
		res.status(500).json({ message: "Gagal mengambil data shift normal" });
	}
};

export const createShiftNormal = async (req, res) => {
	const validation = validateShiftBody(req.body);
	if (!validation.valid) {
		return res.status(400).json({ message: validation.errors.join("; ") });
	}
	const { shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight } = validation.data;

	try {
		const [result] = await safeIKMQuery(
			"INSERT INTO mst_shift_normal (shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight) VALUES (?, ?, ?, ?, ?, ?)",
			[shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight],
		);
		const [rows] = await safeIKMQuery("SELECT * FROM mst_shift_normal WHERE id = ?", [result.insertId]);
		res.status(201).json({ message: "Shift normal berhasil ditambahkan", data: rows[0] });
	} catch (error) {
		console.error("[masterAbsensi] createShiftNormal error:", error);
		if (error.code === "ER_DUP_ENTRY") {
			return res.status(409).json({ message: "Nama shift sudah ada" });
		}
		res.status(500).json({ message: "Gagal menambahkan shift normal" });
	}
};

export const updateShiftNormal = async (req, res) => {
	const id = toPositiveInt(req.params.id);
	if (!id) return res.status(400).json({ message: "ID tidak valid" });

	const validation = validateShiftBody(req.body);
	if (!validation.valid) {
		return res.status(400).json({ message: validation.errors.join("; ") });
	}
	const { shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight } = validation.data;

	try {
		const [result] = await safeIKMQuery(
			"UPDATE mst_shift_normal SET shift_name = ?, check_in_start = ?, check_in_end = ?, check_out_start = ?, check_out_end = ?, is_overnight = ? WHERE id = ?",
			[shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight, id],
		);
		if (result.affectedRows === 0) return res.status(404).json({ message: "Shift normal tidak ditemukan" });
		const [rows] = await safeIKMQuery("SELECT * FROM mst_shift_normal WHERE id = ?", [id]);
		res.json({ message: "Shift normal berhasil diperbarui", data: rows[0] });
	} catch (error) {
		console.error("[masterAbsensi] updateShiftNormal error:", error);
		if (error.code === "ER_DUP_ENTRY") {
			return res.status(409).json({ message: "Nama shift sudah ada" });
		}
		res.status(500).json({ message: "Gagal memperbarui shift normal" });
	}
};

export const deleteShiftNormal = async (req, res) => {
	const id = toPositiveInt(req.params.id);
	if (!id) return res.status(400).json({ message: "ID tidak valid" });

	try {
		const [result] = await safeIKMQuery("DELETE FROM mst_shift_normal WHERE id = ?", [id]);
		if (result.affectedRows === 0) return res.status(404).json({ message: "Shift normal tidak ditemukan" });
		res.json({ message: "Shift normal berhasil dihapus" });
	} catch (error) {
		console.error("[masterAbsensi] deleteShiftNormal error:", error);
		res.status(500).json({ message: "Gagal menghapus shift normal" });
	}
};

// ─── Shift Valet CRUD ──────────────────────────────────────────────────────

export const getShiftsValet = async (req, res) => {
	try {
		const [rows] = await safeIKMQuery(
			"SELECT id, shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight, created_at, updated_at FROM mst_shift_valet ORDER BY id ASC",
			[],
		);
		res.json({ data: rows });
	} catch (error) {
		console.error("[masterAbsensi] getShiftsValet error:", error);
		res.status(500).json({ message: "Gagal mengambil data shift valet" });
	}
};

export const createShiftValet = async (req, res) => {
	const validation = validateShiftBody(req.body);
	if (!validation.valid) {
		return res.status(400).json({ message: validation.errors.join("; ") });
	}
	const { shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight } = validation.data;

	try {
		const [result] = await safeIKMQuery(
			"INSERT INTO mst_shift_valet (shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight) VALUES (?, ?, ?, ?, ?, ?)",
			[shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight],
		);
		const [rows] = await safeIKMQuery("SELECT * FROM mst_shift_valet WHERE id = ?", [result.insertId]);
		res.status(201).json({ message: "Shift valet berhasil ditambahkan", data: rows[0] });
	} catch (error) {
		console.error("[masterAbsensi] createShiftValet error:", error);
		if (error.code === "ER_DUP_ENTRY") {
			return res.status(409).json({ message: "Nama shift sudah ada" });
		}
		res.status(500).json({ message: "Gagal menambahkan shift valet" });
	}
};

export const updateShiftValet = async (req, res) => {
	const id = toPositiveInt(req.params.id);
	if (!id) return res.status(400).json({ message: "ID tidak valid" });

	const validation = validateShiftBody(req.body);
	if (!validation.valid) {
		return res.status(400).json({ message: validation.errors.join("; ") });
	}
	const { shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight } = validation.data;

	try {
		const [result] = await safeIKMQuery(
			"UPDATE mst_shift_valet SET shift_name = ?, check_in_start = ?, check_in_end = ?, check_out_start = ?, check_out_end = ?, is_overnight = ? WHERE id = ?",
			[shift_name, check_in_start, check_in_end, check_out_start, check_out_end, is_overnight, id],
		);
		if (result.affectedRows === 0) return res.status(404).json({ message: "Shift valet tidak ditemukan" });
		const [rows] = await safeIKMQuery("SELECT * FROM mst_shift_valet WHERE id = ?", [id]);
		res.json({ message: "Shift valet berhasil diperbarui", data: rows[0] });
	} catch (error) {
		console.error("[masterAbsensi] updateShiftValet error:", error);
		if (error.code === "ER_DUP_ENTRY") {
			return res.status(409).json({ message: "Nama shift sudah ada" });
		}
		res.status(500).json({ message: "Gagal memperbarui shift valet" });
	}
};

export const deleteShiftValet = async (req, res) => {
	const id = toPositiveInt(req.params.id);
	if (!id) return res.status(400).json({ message: "ID tidak valid" });

	try {
		const [result] = await safeIKMQuery("DELETE FROM mst_shift_valet WHERE id = ?", [id]);
		if (result.affectedRows === 0) return res.status(404).json({ message: "Shift valet tidak ditemukan" });
		res.json({ message: "Shift valet berhasil dihapus" });
	} catch (error) {
		console.error("[masterAbsensi] deleteShiftValet error:", error);
		res.status(500).json({ message: "Gagal menghapus shift valet" });
	}
};
