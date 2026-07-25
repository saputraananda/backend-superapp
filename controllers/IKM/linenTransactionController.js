import { safeIKMQuery, safeQuery } from "../../db/pool.js";

function toISODateString(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v || "") ? v : null;
}

function toPositiveInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const getHospitals = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      "SELECT id, hospital_name FROM mst_hospital ORDER BY hospital_name ASC"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getHospitalRooms = async (req, res) => {
  try {
    const hospitalId = Number(req.params.hospitalId);
    if (!hospitalId) {
      return res.status(400).json({ success: false, message: "Hospital ID invalid" });
    }
    const [rows] = await safeIKMQuery(
      "SELECT id, room_name FROM mst_rooms_rs WHERE hospital_id = ? ORDER BY room_name ASC",
      [hospitalId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLinenTransactions = async (req, res) => {
  try {
    const { hospital_id, room_id, kurang_kirim_only, startDate, endDate, search, page, limit } = req.query;

    const pg = toPositiveInt(page) ?? 1;
    const lm = Math.min(toPositiveInt(limit) ?? 25, 100);
    const offset = (pg - 1) * lm;

    const where = [];
    const params = [];

    if (hospital_id) {
      where.push("tr.hospital_id = ?");
      params.push(Number(hospital_id));
    }

    if (startDate) {
      where.push("tr.pickup_date >= ?");
      params.push(startDate + " 00:00:00");
    }

    if (endDate) {
      where.push("tr.pickup_date <= ?");
      params.push(endDate + " 23:59:59");
    }

    if (search?.trim()) {
      const like = `%${search.trim()}%`;
      where.push("(tr.form_number LIKE ? OR tr.notes_pickup LIKE ? OR tr.notes_delivery LIKE ? OR h.hospital_name LIKE ? OR tr.pickup_date LIKE ? OR tr.delivery_date LIKE ? OR tr.status LIKE ?)");
      params.push(like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Count SQL
    let countParams = [];
    if (room_id) {
      countParams.push(Number(room_id));
    }
    countParams = [...countParams, ...params];

    const countSql = `
      SELECT COUNT(*) AS total FROM (
        SELECT tr.id,
               COALESCE(SUM(d.qty_kotor), 0) AS total_kotor,
               COALESCE(SUM(d.qty_bersih), 0) AS total_bersih
        FROM tr_linen_transaction tr
        LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
        LEFT JOIN tr_linen_transaction_detail d ON d.transaction_id = tr.id
        ${room_id ? 'INNER JOIN mst_hospital_linen_rooms hlr ON hlr.hospital_linen_id = d.hospital_linen_id AND hlr.room_id = ?' : ''}
        ${whereSql}
        GROUP BY tr.id
        ${kurang_kirim_only === 'true' || kurang_kirim_only === true ? 'HAVING total_kotor != total_bersih' : ''}
      ) temp
    `;

    const [[{ total }]] = await safeIKMQuery(countSql, countParams);

    // Fetch SQL
    let selectParams = [];
    if (room_id) {
      selectParams.push(Number(room_id));
    }
    selectParams = [...selectParams, ...params];

    const fetchSql = `
      SELECT tr.id, tr.form_number, tr.hospital_id, tr.user_pickup, tr.user_delivery, tr.pickup_date, tr.delivery_date, tr.status, tr.notes_pickup, tr.notes_delivery,
             h.hospital_name,
             COALESCE(SUM(d.qty_kotor), 0) AS total_kotor,
             COALESCE(SUM(d.qty_bersih), 0) AS total_bersih,
             (COALESCE(SUM(d.qty_kotor), 0) - COALESCE(SUM(d.qty_bersih), 0)) AS kurang_kirim
      FROM tr_linen_transaction tr
      LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
      LEFT JOIN tr_linen_transaction_detail d ON d.transaction_id = tr.id
      ${room_id ? 'INNER JOIN mst_hospital_linen_rooms hlr ON hlr.hospital_linen_id = d.hospital_linen_id AND hlr.room_id = ?' : ''}
      ${whereSql}
      GROUP BY tr.id
      ${kurang_kirim_only === 'true' || kurang_kirim_only === true ? 'HAVING total_kotor != total_bersih' : ''}
      ORDER BY tr.pickup_date DESC, tr.id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await safeIKMQuery(fetchSql, [...selectParams, lm, offset]);

    if (rows.length) {
      const employeeIds = [...new Set(rows.flatMap(r => [r.user_pickup, r.user_delivery]).filter(Boolean))];
      if (employeeIds.length) {
        const ph = employeeIds.map(() => "?").join(",");
        const [emps] = await safeQuery(
          `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`,
          employeeIds
        );
        const empMap = new Map(emps.map(e => [e.employee_id, e.full_name]));
        rows.forEach(r => {
          r.pickup_by_name = empMap.get(r.user_pickup) || "-";
          r.delivery_by_name = empMap.get(r.user_delivery) || "-";
        });
      } else {
        rows.forEach(r => {
          r.pickup_by_name = "-";
          r.delivery_by_name = "-";
        });
      }
    }

    res.json({
      success: true,
      data: rows,
      pagination: {
        page: pg,
        limit: lm,
        total,
        totalPages: Math.ceil(total / lm),
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getLinenTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const roomId = req.query.room_id ? Number(req.query.room_id) : null;

    // Fetch Header
    const [headers] = await safeIKMQuery(
      `SELECT tr.id, tr.form_number, tr.hospital_id, tr.user_pickup, tr.user_delivery,
              tr.hospital_staff_pickup, tr.hospital_staff_delivery,
              tr.hospital_assistant_pickup, tr.hospital_assistant_delivery,
              tr.signature_valet_pickup, tr.signature_hospital_pickup, tr.signature_assistant_pickup,
              tr.signature_valet_delivery, tr.signature_hospital_delivery, tr.signature_assistant_delivery,
              tr.pickup_date, tr.delivery_date, tr.status, tr.notes_pickup, tr.notes_delivery,
              h.hospital_name
       FROM tr_linen_transaction tr
       LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
       WHERE tr.id = ?`,
      [id]
    );

    if (!headers.length) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });
    }

    const header = headers[0];
    const employeeIds = [header.user_pickup, header.user_delivery].filter(Boolean);
    if (employeeIds.length) {
      const ph = employeeIds.map(() => "?").join(",");
      const [emps] = await safeQuery(
        `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${ph})`,
        employeeIds
      );
      const empMap = new Map(emps.map(e => [e.employee_id, e.full_name]));
      header.pickup_by_name = empMap.get(header.user_pickup) || "-";
      header.delivery_by_name = empMap.get(header.user_delivery) || "-";
    } else {
      header.pickup_by_name = "-";
      header.delivery_by_name = "-";
    }

    // Fetch Details
    let detailSql = `
      SELECT d.id, d.transaction_id, d.hospital_linen_id, d.qty_kotor, d.qty_bersih, d.notes,
             hl.hospital_linen_name, hl.ownership_type,
             l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name
      FROM tr_linen_transaction_detail d
      LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
      LEFT JOIN mst_linen l ON l.id = hl.linen_id
      LEFT JOIN mst_size sz ON l.size_id = sz.id
      LEFT JOIN mst_color cl ON l.color_id = cl.id
      LEFT JOIN mst_material mt ON l.material_id = mt.id
    `;
    const params = [];
    if (roomId) {
      detailSql += `
        INNER JOIN mst_hospital_linen_rooms hlr ON hlr.hospital_linen_id = d.hospital_linen_id AND hlr.room_id = ?
        WHERE d.transaction_id = ?
      `;
      params.push(roomId, id);
    } else {
      detailSql += `
        WHERE d.transaction_id = ?
      `;
      params.push(id);
    }

    const [details] = await safeIKMQuery(detailSql, params);

    // Fetch Audit Logs
    const [auditLogs] = await safeIKMQuery(
      `SELECT id, action, user_id, username, full_name, role, old_values, new_values, created_at
       FROM tr_linen_transaction_audit
       WHERE transaction_id = ?
       ORDER BY id DESC`,
      [id]
    );

    const parsedLogs = auditLogs.map(log => {
      try {
        return {
          ...log,
          old_values: typeof log.old_values === "string" ? JSON.parse(log.old_values) : log.old_values,
          new_values: typeof log.new_values === "string" ? JSON.parse(log.new_values) : log.new_values
        };
      } catch {
        return log;
      }
    });

    const uniqueLinenIds = new Set();
    parsedLogs.forEach(log => {
      const oldD = log.old_values?.details || [];
      const newD = log.new_values?.details || [];
      oldD.forEach(d => { if (d.hospital_linen_id) uniqueLinenIds.add(d.hospital_linen_id); });
      newD.forEach(d => { if (d.hospital_linen_id) uniqueLinenIds.add(d.hospital_linen_id); });
    });

    const linenNameMap = new Map();
    if (uniqueLinenIds.size > 0) {
      const ids = [...uniqueLinenIds];
      const ph = ids.map(() => "?").join(",");
      const [linens] = await safeIKMQuery(
        `SELECT hl.id AS hospital_linen_id, hl.hospital_linen_name, 
                l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name
         FROM mst_hospital_linen hl
         LEFT JOIN mst_linen l ON l.id = hl.linen_id
         LEFT JOIN mst_size sz ON l.size_id = sz.id
         LEFT JOIN mst_color cl ON l.color_id = cl.id
         LEFT JOIN mst_material mt ON l.material_id = mt.id
         WHERE hl.id IN (${ph})`,
        ids
      );
      linens.forEach(l => {
        const parts = [l.master_linen_name, l.size_name, l.color_name, l.material_name].filter(Boolean);
        linenNameMap.set(l.hospital_linen_id, l.hospital_linen_name || parts.join(" "));
      });
    }

    const enrichedLogs = parsedLogs.map(log => {
      if (!log.old_values && !log.new_values) return log;

      const oldD = log.old_values?.details || [];
      const newD = log.new_values?.details || [];

      const enrichedOldD = oldD.map(d => ({
        ...d,
        linen_display_name: d.linen_display_name || linenNameMap.get(d.hospital_linen_id) || `Item #${d.hospital_linen_id}`
      }));
      const enrichedNewD = newD.map(d => ({
        ...d,
        linen_display_name: d.linen_display_name || linenNameMap.get(d.hospital_linen_id) || `Item #${d.hospital_linen_id}`
      }));

      return {
        ...log,
        old_values: log.old_values ? { ...log.old_values, details: enrichedOldD } : null,
        new_values: log.new_values ? { ...log.new_values, details: enrichedNewD } : null
      };
    });

    res.json({
      success: true,
      data: {
        header,
        details: details.map(d => {
          const parts = [d.master_linen_name, d.size_name, d.color_name, d.material_name].filter(Boolean);
          return {
            ...d,
            linen_display_name: d.hospital_linen_name || parts.join(" ")
          };
        }),
        auditLogs: enrichedLogs
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── Audit Log Helpers ────────────────────────────────────────────────────────
async function writeAuditLog(transactionId, action, req, oldValues = null, newValues = null) {
  try {
    let userId = null;
    let username = "system";
    let fullName = "System Admin";
    const role = req.session?.userRole || "admin";

    if (req.session?.userEmail) {
      const [empRows] = await safeQuery(
        "SELECT employee_id, full_name, email FROM mst_employee WHERE email = ?",
        [req.session.userEmail]
      );
      if (empRows.length > 0) {
        userId = empRows[0].employee_id;
        username = req.session.userName || empRows[0].email;
        fullName = empRows[0].full_name;
      } else {
        userId = req.session.userId || null;
        username = req.session.userName || req.session.userEmail || "system";
        fullName = req.session.userName || "System Admin";
      }
    } else {
      userId = req.session?.user?.id || req.session?.user?.user_id || req.user?.id || null;
      username = req.session?.user?.username || req.session?.user?.email || req.user?.username || "system";
      fullName = req.session?.user?.employee?.full_name || req.session?.user?.name || req.user?.full_name || "System Admin";
    }

    await safeIKMQuery(
      `INSERT INTO tr_linen_transaction_audit 
       (transaction_id, action, user_id, username, full_name, role, old_values, new_values) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionId,
        action,
        userId,
        username,
        fullName,
        role,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null
      ]
    );
  } catch (err) {
    console.error("Failed to write audit log:", err.message);
  }
}

async function getTransactionSnapshot(transactionId) {
  const [headers] = await safeIKMQuery(
    "SELECT * FROM tr_linen_transaction WHERE id = ?",
    [transactionId]
  );
  if (!headers.length) return null;

  const [details] = await safeIKMQuery(
    `SELECT d.*, hl.hospital_linen_name,
            l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name
     FROM tr_linen_transaction_detail d
     LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
     LEFT JOIN mst_linen l ON l.id = hl.linen_id
     LEFT JOIN mst_size sz ON l.size_id = sz.id
     LEFT JOIN mst_color cl ON l.color_id = cl.id
     LEFT JOIN mst_material mt ON l.material_id = mt.id
     WHERE d.transaction_id = ?`,
    [transactionId]
  );

  return {
    header: headers[0],
    details: details.map(d => {
      const parts = [d.master_linen_name, d.size_name, d.color_name, d.material_name].filter(Boolean);
      return { ...d, linen_display_name: d.hospital_linen_name || parts.join(" ") };
    })
  };
}

// ── CRUD Endpoints ───────────────────────────────────────────────────────────
export const getEmployees = async (req, res) => {
  try {
    const [rows] = await safeQuery(
      "SELECT employee_id, full_name FROM mst_employee WHERE company_id = 2 AND exit_date IS NULL ORDER BY full_name ASC"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getHospitalLinens = async (req, res) => {
  try {
    const hospitalId = Number(req.params.hospitalId);
    if (!hospitalId) {
      return res.status(400).json({ success: false, message: "Hospital ID invalid" });
    }
    const [rows] = await safeIKMQuery(
      `SELECT hl.id AS hospital_linen_id, hl.hospital_linen_name, hl.ownership_type,
              l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name
       FROM mst_hospital_linen hl
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE hl.hospital_id = ? AND hl.is_active = 1
       ORDER BY hl.hospital_linen_name ASC, l.linen_name ASC`,
      [hospitalId]
    );
    res.json({
      success: true,
      data: rows.map(r => {
        const parts = [r.master_linen_name, r.size_name, r.color_name, r.material_name].filter(Boolean);
        return {
          ...r,
          linen_display_name: r.hospital_linen_name || parts.join(" ")
        };
      })
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createLinenTransaction = async (req, res) => {
  try {
    const {
      hospital_id,
      user_pickup,
      user_delivery,
      pickup_date,
      delivery_date,
      notes_pickup,
      notes_delivery,
      status,
      details
    } = req.body;

    if (!hospital_id || !user_pickup || !pickup_date) {
      return res.status(400).json({ success: false, message: "Parameter wajib tidak lengkap" });
    }

    // Generate form number: {hospitalCode}-{yyyymmdd}-{0001} (sequential per hospital+day)
    const d = new Date(pickup_date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyymmdd = `${yyyy}${mm}${dd}`;

    const [countResult] = await safeIKMQuery(
      `SELECT COUNT(*) as cnt FROM tr_linen_transaction
       WHERE hospital_id = ? AND DATE(pickup_date) = DATE(?)`,
      [Number(hospital_id), pickup_date]
    );
    const nextSeq = (countResult?.[0]?.cnt || 0) + 1;

    // Get the hospital_id code from mst_hospital
    const [hospitalRows] = await safeIKMQuery(
      `SELECT hospital_id FROM mst_hospital WHERE id = ?`,
      [Number(hospital_id)]
    );
    const hospitalCode = hospitalRows?.[0]?.hospital_id || hospital_id;
    const form_number = `${hospitalCode}-${yyyymmdd}-${String(nextSeq).padStart(3, '0')}`;

    // Insert Header
    const [result] = await safeIKMQuery(
      `INSERT INTO tr_linen_transaction 
       (form_number, hospital_id, user_pickup, user_delivery, pickup_date, delivery_date, status, notes_pickup, notes_delivery) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        form_number,
        Number(hospital_id),
        Number(user_pickup),
        user_delivery ? Number(user_delivery) : null,
        pickup_date,
        delivery_date || null,
        status || "PROSES",
        notes_pickup || null,
        notes_delivery || null
      ]
    );

    const transactionId = result.insertId;

    // Insert Details
    if (details && Array.isArray(details) && details.length > 0) {
      const detailValues = [];
      const queryParams = [];
      details.forEach(d => {
        detailValues.push("(?, ?, ?, ?, ?)");
        queryParams.push(
          transactionId,
          Number(d.hospital_linen_id),
          Number(d.qty_kotor || 0),
          d.qty_bersih !== undefined && d.qty_bersih !== null ? Number(d.qty_bersih) : null,
          d.notes || null
        );
      });

      await safeIKMQuery(
        `INSERT INTO tr_linen_transaction_detail 
         (transaction_id, hospital_linen_id, qty_kotor, qty_bersih, notes) 
         VALUES ${detailValues.join(", ")}`,
        queryParams
      );
    }

    // Capture snapshot for audit log
    const snapshot = await getTransactionSnapshot(transactionId);
    await writeAuditLog(transactionId, "PICKUP_KOTOR", req, null, snapshot);

    res.json({ success: true, message: "Transaksi berhasil dibuat", transactionId });

  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ success: false, message: "Nomor Formulir sudah digunakan" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateLinenTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      form_number,
      user_pickup,
      user_delivery,
      hospital_staff_pickup,
      hospital_staff_delivery,
      hospital_assistant_pickup,
      hospital_assistant_delivery,
      pickup_date,
      delivery_date,
      notes_pickup,
      notes_delivery,
      status,
      details
    } = req.body;

    if (!form_number || !user_pickup || !pickup_date) {
      return res.status(400).json({ success: false, message: "Parameter wajib tidak lengkap" });
    }

    // Capture old snapshot
    const oldSnapshot = await getTransactionSnapshot(id);
    if (!oldSnapshot) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });
    }

    // Update Header
    await safeIKMQuery(
      `UPDATE tr_linen_transaction 
       SET form_number = ?, 
           user_pickup = ?, 
           user_delivery = ?,
           hospital_staff_pickup = ?,
           hospital_staff_delivery = ?,
           hospital_assistant_pickup = ?,
           hospital_assistant_delivery = ?,
           pickup_date = ?, 
           delivery_date = ?, 
           status = ?, 
           notes_pickup = ?,
           notes_delivery = ?
       WHERE id = ?`,
      [
        form_number,
        Number(user_pickup),
        user_delivery ? Number(user_delivery) : null,
        hospital_staff_pickup || null,
        hospital_staff_delivery || null,
        hospital_assistant_pickup || null,
        hospital_assistant_delivery || null,
        pickup_date,
        delivery_date || null,
        status || "PROSES",
        notes_pickup || null,
        notes_delivery || null,
        id
      ]
    );

    // Delete old details
    await safeIKMQuery(
      "DELETE FROM tr_linen_transaction_detail WHERE transaction_id = ?",
      [id]
    );

    // Insert new details
    if (details && Array.isArray(details) && details.length > 0) {
      const detailValues = [];
      const queryParams = [];
      details.forEach(d => {
        detailValues.push("(?, ?, ?, ?, ?)");
        queryParams.push(
          id,
          Number(d.hospital_linen_id),
          Number(d.qty_kotor || 0),
          d.qty_bersih !== undefined && d.qty_bersih !== null ? Number(d.qty_bersih) : null,
          d.notes || null
        );
      });

      await safeIKMQuery(
        `INSERT INTO tr_linen_transaction_detail 
         (transaction_id, hospital_linen_id, qty_kotor, qty_bersih, notes) 
         VALUES ${detailValues.join(", ")}`,
        queryParams
      );
    }

    // Capture new snapshot
    const newSnapshot = await getTransactionSnapshot(id);
    await writeAuditLog(id, "ADMIN", req, oldSnapshot, newSnapshot);

    res.json({ success: true, message: "Transaksi berhasil diperbarui" });

  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ success: false, message: "Nomor Formulir sudah digunakan" });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteLinenTransaction = async (req, res) => {
  try {
    const { id } = req.params;

    // Delete header (cascades automatically delete details and audit logs)
    const [result] = await safeIKMQuery(
      "DELETE FROM tr_linen_transaction WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });
    }

    res.json({ success: true, message: "Transaksi berhasil dihapus" });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getRekapCuciLinen = async (req, res) => {
  try {
    const { startDate, endDate, hospital_id, ownership_type } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: "Tanggal awal dan akhir harus diisi" });
    }

    // 1. Get hospitals
    let hospitalSql = "SELECT id, hospital_name FROM mst_hospital";
    let hospitalParams = [];
    if (hospital_id) {
      hospitalSql += " WHERE id = ?";
      hospitalParams.push(Number(hospital_id));
    }
    hospitalSql += " ORDER BY hospital_name ASC";
    const [hospitals] = await safeIKMQuery(hospitalSql, hospitalParams);

    if (hospitals.length === 0) {
      return res.json({ success: true, hospitals: [], linens: [], transactions: [] });
    }

    const hospitalIds = hospitals.map(h => h.id);
    const ph = hospitalIds.map(() => "?").join(",");

    // 2. Get active linens for these hospitals
    let linenSql = `
      SELECT 
        hl.id AS hospital_linen_id, 
        hl.hospital_id,
        hl.hospital_linen_name, 
        hl.ownership_type,
        hl.grammage,
        hl.washing_price_type,
        hl.washing_price,
        hl.rental_price,
        l.linen_name AS master_linen_name, 
        sz.size_name, 
        cl.color_name, 
        mt.material_name
      FROM mst_hospital_linen hl
      LEFT JOIN mst_linen l ON l.id = hl.linen_id
      LEFT JOIN mst_size sz ON l.size_id = sz.id
      LEFT JOIN mst_color cl ON l.color_id = cl.id
      LEFT JOIN mst_material mt ON l.material_id = mt.id
      WHERE hl.is_active = 1 AND hl.hospital_id IN (${ph})
    `;
    let linenParams = [...hospitalIds];

    if (ownership_type) {
      linenSql += " AND hl.ownership_type = ?";
      linenParams.push(ownership_type);
    }
    linenSql += " ORDER BY hl.hospital_id ASC, hl.hospital_linen_name ASC, l.linen_name ASC";
    const [linens] = await safeIKMQuery(linenSql, linenParams);

    // 3. Get transactions date-grouped counts
    const [txRows] = await safeIKMQuery(
      `SELECT 
        tr.hospital_id,
        DATE_FORMAT(tr.pickup_date, '%Y-%m-%d') as tx_date,
        d.hospital_linen_id,
        SUM(d.qty_kotor) as total_qty_kotor,
        SUM(d.qty_bersih) as total_qty_bersih
       FROM tr_linen_transaction tr
       JOIN tr_linen_transaction_detail d ON d.transaction_id = tr.id
       WHERE tr.hospital_id IN (${ph})
         AND tr.pickup_date >= ? 
         AND tr.pickup_date <= ?
       GROUP BY tr.hospital_id, DATE_FORMAT(tr.pickup_date, '%Y-%m-%d'), d.hospital_linen_id`,
      [...hospitalIds, startDate + " 00:00:00", endDate + " 23:59:59"]
    );

    res.json({
      success: true,
      hospitals,
      linens: linens.map(r => {
        const parts = [r.master_linen_name, r.size_name, r.color_name, r.material_name].filter(Boolean);
        return {
          ...r,
          linen_display_name: r.hospital_linen_name || parts.join(" ")
        };
      }),
      transactions: txRows
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const proxySignature = async (req, res) => {
  try {
    const name = String(req.query.name || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, message: "Parameter 'name' wajib diisi" });
    }
    // Prevent path traversal
    if (name.includes("..") || name.includes("/") || name.includes("\\")) {
      return res.status(400).json({ success: false, message: "Nama file tidak valid" });
    }

    const baseUrl = process.env.IKM_SIGNATURE_BASE_URL || "https://linen.ikmalora.com/storage/assets/serahterimalinen";
    const targetUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;

    const upstream = await fetch(targetUrl, { method: "GET" });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, message: `Gagal memuat file (${upstream.status})` });
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");

    const arrayBuf = await upstream.arrayBuffer();
    res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.error("[proxySignature] Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};
