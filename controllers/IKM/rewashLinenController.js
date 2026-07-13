import { safeIKMQuery, safeQuery } from "../../db/pool.js";

function toISODateString(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toUInt(v, def = 0) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

function getDefaultCutoffDates() {
  const now = new Date();
  const day = now.getDate();
  const year = now.getFullYear();
  const month = now.getMonth();

  let start, end;
  if (day <= 25) {
    const s = new Date(year, month - 1, 26);
    const e = new Date(year, month, 25);
    start = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-26`;
    end   = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-25`;
  } else {
    const s = new Date(year, month, 26);
    const e = new Date(year, month + 1, 25);
    start = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-26`;
    end   = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, "0")}-25`;
  }
  return { start, end };
}

function resolveReportedBy(req) {
  return (
    req.session?.user?.employee?.employee_id ||
    req.session?.user?.employeeId ||
    req.session?.employeeId ||
    0
  );
}

// ── GET List — headers grouped ──
export const getRewashLinens = async (req, res) => {
  try {
    const { startDate, endDate, hospital_id, search, page, limit } = req.query;

    const defaultCutoff = getDefaultCutoffDates();
    const start = toISODateString(startDate) || defaultCutoff.start;
    const end   = toISODateString(endDate)   || defaultCutoff.end;
    const pg    = toPositiveInt(page) ?? 1;
    const lm    = Math.min(toPositiveInt(limit) ?? 25, 100);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    where.push("tr.report_date >= ?"); params.push(start);
    where.push("tr.report_date <= ?"); params.push(end);

    if (hospital_id) {
      where.push("tr.hospital_id = ?");
      params.push(Number(hospital_id));
    }

    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(tr.reporter_name LIKE ? OR h.hospital_name LIKE ?)");
      params.push(like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Count total headers
    const [[{ total }]] = await safeIKMQuery(
      `SELECT COUNT(*) AS total FROM tr_rewash tr ${whereSql}`,
      params
    );

    // Fetch headers
    const [headers] = await safeIKMQuery(
      `SELECT tr.id, tr.reporter_name, tr.report_date, tr.hospital_id, tr.notes,
              tr.reported_by, tr.created_at, tr.updated_at,
              h.hospital_name
       FROM tr_rewash tr
       LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
       ${whereSql}
       ORDER BY tr.report_date DESC, tr.id DESC
       LIMIT ? OFFSET ?`,
      [...params, lm, offset]
    );

    if (!headers.length) {
      const [hospitals] = await safeIKMQuery(
        "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
      );
      return res.json({ data: [], pagination: { page: pg, limit: lm, total: 0, totalPages: 0 }, hospitals });
    }

    // Enrich reported_by with employee name
    const reportedByIds = [...new Set(headers.map((r) => r.reported_by).filter(Boolean))];
    const employeeMap = new Map();
    if (reportedByIds.length) {
      const ph = reportedByIds.map(() => "?").join(",");
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`,
        reportedByIds
      );
      emps.forEach((e) => employeeMap.set(e.employee_id, e.full_name));
    }

    // Fetch all details for these headers
    const headerIds = headers.map((h) => h.id);
    const [details] = await safeIKMQuery(
      `SELECT d.id, d.rewash_id, d.hospital_linen_id, d.qty, d.clear, d.detail_notes, d.created_at, d.updated_at,
              hl.hospital_linen_name, hl.ownership_type, l.linen_name AS master_linen_name,
              sz.size_name, cl.color_name, mt.material_name
       FROM tr_rewash_detail d
       LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE d.rewash_id IN (${headerIds.map(() => "?").join(",")})
       ORDER BY d.id ASC`,
      headerIds
    );

    // Group details under headers
    const detailMap = {};
    for (const d of details) {
      if (!detailMap[d.rewash_id]) detailMap[d.rewash_id] = [];
      const parts = [d.master_linen_name, d.size_name, d.color_name, d.material_name].filter(Boolean);
      detailMap[d.rewash_id].push({
        id: d.id,
        hospital_linen_id: d.hospital_linen_id,
        hospital_linen_name: d.hospital_linen_name,
        linen_display_name: parts.join(" "),
        master_linen_name: d.master_linen_name,
        ownership_type: d.ownership_type,
        qty: d.qty,
        clear: d.clear ?? 0,
        detail_notes: d.detail_notes || null,
        created_at: d.created_at,
        updated_at: d.updated_at,
      });
    }

    const records = headers.map((h) => ({
      id: h.id,
      reporter_name: h.reporter_name,
      report_date: h.report_date,
      hospital_id: h.hospital_id,
      hospital_name: h.hospital_name,
      notes: h.notes,
      reported_by: h.reported_by,
      reporter_employee_name: employeeMap.get(h.reported_by) || null,
      items: detailMap[h.id] || [],
      created_at: h.created_at,
      updated_at: h.updated_at,
    }));

    const [hospitals] = await safeIKMQuery(
      "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
    );

    res.json({
      data: records,
      pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) },
      hospitals,
    });
  } catch (err) {
    console.error("getRewashLinens error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET Meta ──
export const getRewashLinenMeta = async (req, res) => {
  try {
    const [hospitals] = await safeIKMQuery(
      "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
    );
    res.json({ hospitals });
  } catch (err) {
    console.error("getRewashLinenMeta error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── POST Create — header (upsert) + detail ──
export const createRewashLinen = async (req, res) => {
  try {
    const { reporter_name, report_date, hospital_id, hospital_linen_id, qty, notes } = req.body;

    if (!reporter_name?.trim()) {
      return res.status(400).json({ message: "Nama pelapor wajib diisi" });
    }
    const date = toISODateString(report_date);
    if (!date) {
      return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    }
    if (!toPositiveInt(hospital_id)) {
      return res.status(400).json({ message: "Rumah sakit wajib dipilih" });
    }
    if (!toPositiveInt(hospital_linen_id)) {
      return res.status(400).json({ message: "Linen wajib dipilih" });
    }
    const cleanQty = toUInt(qty, 0);

    const reportedBy = resolveReportedBy(req);

    // Upsert header — find existing by (report_date, hospital_id, reporter_name)
    const [existing] = await safeIKMQuery(
      `SELECT id FROM tr_rewash
       WHERE report_date = ? AND hospital_id = ? AND reporter_name = ?`,
      [date, Number(hospital_id), reporter_name.trim()]
    );

    let headerId;
    if (existing.length) {
      headerId = existing[0].id;
      // Update notes if provided
      if (notes != null) {
        await safeIKMQuery(
          `UPDATE tr_rewash SET notes = ?, updated_at = NOW() WHERE id = ?`,
          [notes, headerId]
        );
      }
    } else {
      const [result] = await safeIKMQuery(
        `INSERT INTO tr_rewash (reporter_name, report_date, hospital_id, notes, reported_by)
         VALUES (?, ?, ?, ?, ?)`,
        [reporter_name.trim(), date, Number(hospital_id), notes || null, reportedBy]
      );
      headerId = result.insertId;
    }

    // Insert detail
    const [result] = await safeIKMQuery(
      `INSERT INTO tr_rewash_detail (rewash_id, hospital_linen_id, qty)
       VALUES (?, ?, ?)`,
      [headerId, Number(hospital_linen_id), cleanQty]
    );

    res.status(201).json({
      message: "Data rewash linen berhasil ditambahkan",
      id: result.insertId,
      headerId,
    });
  } catch (err) {
    console.error("createRewashLinen error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT Update detail qty / clear / detail_notes ──
export const updateRewashDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, rewash_id, qty FROM tr_rewash_detail WHERE id = ?", [id]
    );
    if (!exist.length) {
      return res.status(404).json({ message: "Data detail rewash tidak ditemukan" });
    }

    const { qty, clear, detail_notes } = req.body;
    const fields = [];
    const vals   = [];

    if (qty !== undefined) {
      const cleanQty = toUInt(qty, 0);
      fields.push("qty = ?");
      vals.push(cleanQty);
    }

    if (clear !== undefined) {
      const currentQty = exist[0].qty;
      const cleanClear = Math.min(toUInt(clear, 0), currentQty);
      fields.push("`clear` = ?");
      vals.push(cleanClear);
    }

    if (detail_notes !== undefined) {
      fields.push("detail_notes = ?");
      vals.push(detail_notes?.trim() || null);
    }

    if (!fields.length) {
      return res.status(400).json({ message: "Tidak ada field yang diperbarui" });
    }

    vals.push(id);
    await safeIKMQuery(
      `UPDATE tr_rewash_detail SET ${fields.join(", ")}, updated_at = NOW() WHERE id = ?`,
      vals
    );

    res.json({ message: "Data rewash berhasil diperbarui" });
  } catch (err) {
    console.error("updateRewashDetail error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE Detail ──
export const deleteRewashDetail = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id, rewash_id FROM tr_rewash_detail WHERE id = ?", [id]
    );
    if (!exist.length) {
      return res.status(404).json({ message: "Data detail rewash tidak ditemukan" });
    }

    const rewashId = exist[0].rewash_id;

    await safeIKMQuery("DELETE FROM tr_rewash_detail WHERE id = ?", [id]);

    // If no more details, delete the header too
    const [remaining] = await safeIKMQuery(
      "SELECT COUNT(*) AS cnt FROM tr_rewash_detail WHERE rewash_id = ?",
      [rewashId]
    );
    if (remaining[0].cnt === 0) {
      await safeIKMQuery("DELETE FROM tr_rewash WHERE id = ?", [rewashId]);
    }

    res.json({ message: "Data rewash berhasil dihapus" });
  } catch (err) {
    console.error("deleteRewashDetail error:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── PUT Update header (reporter, date, notes) ──
export const updateRewashHeader = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(
      "SELECT id FROM tr_rewash WHERE id = ?", [id]
    );
    if (!exist.length) {
      return res.status(404).json({ message: "Data rewash tidak ditemukan" });
    }

    const { reporter_name, report_date, notes } = req.body;

    if (!reporter_name?.trim()) {
      return res.status(400).json({ message: "Nama pelapor wajib diisi" });
    }
    const date = toISODateString(report_date);
    if (!date) {
      return res.status(400).json({ message: "Tanggal laporan tidak valid" });
    }

    await safeIKMQuery(
      `UPDATE tr_rewash
       SET reporter_name = ?, report_date = ?, notes = ?, updated_at = NOW()
       WHERE id = ?`,
      [reporter_name.trim(), date, notes || null, id]
    );

    res.json({ message: "Data rewash berhasil diperbarui" });
  } catch (err) {
    console.error("updateRewashHeader error:", err);
    res.status(500).json({ message: err.message });
  }
};
