import fs from "fs";
import path from "path";
import { safeIKMQuery, safeQuery } from "../../../db/pool.js";
import { pushKomersilBersihToParent, komersilMeasure } from "./komersilSync.js";

const PARENT_SIG_FIELDS = [
  "signature_valet_pickup", "signature_hospital_pickup", "signature_assistant_pickup",
  "signature_valet_delivery", "signature_hospital_delivery", "signature_assistant_delivery"
];

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
    const { hospital_id, kurang_kirim_only, startDate, endDate, search, page, limit } = req.query;

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
    let countParams = [...params];

    const countSql = `
      SELECT COUNT(*) AS total FROM (
        SELECT tr.id,
               COALESCE(SUM(d.qty_kotor), 0) AS total_kotor,
               COALESCE(SUM(d.qty_bersih), 0) AS total_bersih
        FROM tr_komersil_linen_transaction tr
        LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
        LEFT JOIN tr_komersil_linen_transaction_detail d ON d.transaction_id = tr.id
        ${whereSql}
        GROUP BY tr.id
        ${kurang_kirim_only === 'true' || kurang_kirim_only === true ? 'HAVING total_kotor != total_bersih' : ''}
      ) temp
    `;

    const [[{ total }]] = await safeIKMQuery(countSql, countParams);

    // Fetch SQL
    let selectParams = [...params];

    const fetchSql = `
      SELECT tr.id, tr.form_number, tr.hospital_id, tr.user_pickup, tr.user_delivery, tr.pickup_date, tr.delivery_date, tr.status, tr.notes_pickup, tr.notes_delivery,
             tr.parent_transaction_id, tr.is_express,
             (SELECT p.form_number FROM tr_linen_transaction p WHERE p.id = tr.parent_transaction_id) AS parent_form_number,
             h.hospital_name,
             COALESCE(SUM(d.qty_kotor), 0) AS total_kotor,
             COALESCE(SUM(d.qty_bersih), 0) AS total_bersih,
             (COALESCE(SUM(d.qty_kotor), 0) - COALESCE(SUM(d.qty_bersih), 0)) AS kurang_kirim
      FROM tr_komersil_linen_transaction tr
      LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
      LEFT JOIN tr_komersil_linen_transaction_detail d ON d.transaction_id = tr.id
      ${whereSql}
      GROUP BY tr.id, tr.parent_transaction_id, tr.is_express
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

    // Fetch Header
    const [headers] = await safeIKMQuery(
      `SELECT tr.id, tr.form_number, tr.hospital_id, tr.user_pickup, tr.user_delivery,
              tr.hospital_staff_pickup, tr.hospital_staff_delivery,
              tr.hospital_assistant_pickup, tr.hospital_assistant_delivery,
              tr.signature_valet_pickup, tr.signature_hospital_pickup, tr.signature_assistant_pickup,
              tr.signature_valet_delivery, tr.signature_hospital_delivery, tr.signature_assistant_delivery,
              tr.pickup_date, tr.delivery_date, tr.status, tr.notes_pickup, tr.notes_delivery,
              tr.parent_transaction_id, tr.is_express,
              h.hospital_name
       FROM tr_komersil_linen_transaction tr
       LEFT JOIN mst_hospital h ON h.id = tr.hospital_id
       WHERE tr.id = ?`,
      [id]
    );

    if (!headers.length) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });
    }

    const header = headers[0];
    // Formulir berinduk: TTD & status mengikuti formulir serah terima induk
    if (header.parent_transaction_id) {
      const [[parent]] = await safeIKMQuery("SELECT * FROM tr_linen_transaction WHERE id = ?", [header.parent_transaction_id]);
      if (parent) {
        for (const f of PARENT_SIG_FIELDS) header[f] = parent[f];
        header.status = parent.status;
        header.parent_form_number = parent.form_number;
      }
    }
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
      SELECT d.id, d.transaction_id, d.hospital_linen_id, d.room_id, d.item_name, d.category, d.qty_kotor, d.qty_bersih, d.length_cm, d.width_cm, d.area_m2, d.accessory_qty, d.notes,
             hl.hospital_linen_name, hl.ownership_type, hl.grammage, COALESCE(hl.washing_price_type, 'PCS') AS washing_price_type,
             l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name, r.room_name
      FROM tr_komersil_linen_transaction_detail d
      LEFT JOIN mst_rooms_rs r ON r.id = d.room_id
      LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
      LEFT JOIN mst_linen l ON l.id = hl.linen_id
      LEFT JOIN mst_size sz ON l.size_id = sz.id
      LEFT JOIN mst_color cl ON l.color_id = cl.id
      LEFT JOIN mst_material mt ON l.material_id = mt.id
      WHERE d.transaction_id = ?
    `;

    const [details] = await safeIKMQuery(`${detailSql} ORDER BY r.room_name, d.hospital_linen_id, d.id`, [id]);
    details.forEach(d => { const m = komersilMeasure(d); d.measure_value = m.value; d.measure_unit = m.unit; });

    // Fetch Audit Logs
    const [auditLogs] = await safeIKMQuery(
      `SELECT id, action, user_id, username, full_name, role, old_values, new_values, created_at
       FROM tr_komersil_linen_transaction_audit
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
        linen_display_name: d.item_name || d.linen_display_name || linenNameMap.get(d.hospital_linen_id) || `Item #${d.hospital_linen_id || d.id}`
      }));
      const enrichedNewD = newD.map(d => ({
        ...d,
        linen_display_name: d.item_name || d.linen_display_name || linenNameMap.get(d.hospital_linen_id) || `Item #${d.hospital_linen_id || d.id}`
      }));

      return {
        ...log,
        old_values: log.old_values ? { ...log.old_values, details: enrichedOldD } : null,
        new_values: log.new_values ? { ...log.new_values, details: enrichedNewD } : null
      };
    });

    // Fetch Kurang Kirim Deliveries (Surat Jalan)
    const [deliveries] = await safeIKMQuery(
      `SELECT kd.id, kd.transaction_id, kd.surat_jalan_number, kd.delivery_date, kd.vehicle_number,
              kd.recipient_name, kd.hospital_staff, kd.valet_id, kd.signature_valet, kd.signature_hospital,
              NULL AS notes, kd.created_at,
              tr.pickup_date AS original_pickup_date,
              tr.form_number AS original_form_number
       FROM tr_komersil_kurang_kirim_delivery kd
       LEFT JOIN tr_komersil_linen_transaction tr ON tr.id = kd.transaction_id
       WHERE kd.transaction_id = ?
       ORDER BY kd.delivery_date DESC, kd.id DESC`,
      [id]
    );

    let enrichedDeliveries = [];
    if (deliveries.length > 0) {
      // Get valet names
      const valetIds = [...new Set(deliveries.map(d => d.valet_id).filter(Boolean))];
      let valetMap = new Map();
      if (valetIds.length > 0) {
        const phValets = valetIds.map(() => "?").join(",");
        const [valetRows] = await safeQuery(
          `SELECT employee_id, full_name FROM mst_employee WHERE employee_id IN (${phValets})`,
          valetIds
        );
        valetMap = new Map(valetRows.map(v => [v.employee_id, v.full_name]));
      }

      // Fetch delivery details
      const deliveryIds = deliveries.map(d => d.id);
      const phDeliveries = deliveryIds.map(() => "?").join(",");
      const [allDeliveryDetails] = await safeIKMQuery(
        `SELECT kdd.id, kdd.delivery_id, kdd.komersil_detail_id, kdd.qty_delivered, kdd.length_cm, kdd.width_cm, kdd.area_m2, kdd.notes,
                td.item_name, td.category
         FROM tr_komersil_kurang_kirim_delivery_detail kdd
         LEFT JOIN tr_komersil_linen_transaction_detail td ON td.id = kdd.komersil_detail_id
         WHERE kdd.delivery_id IN (${phDeliveries})
         ORDER BY kdd.id ASC`,
        deliveryIds
      );

      const detailsByDeliveryId = new Map();
      allDeliveryDetails.forEach(dt => {
        if (!detailsByDeliveryId.has(dt.delivery_id)) {
          detailsByDeliveryId.set(dt.delivery_id, []);
        }
        detailsByDeliveryId.get(dt.delivery_id).push(dt);
      });

      enrichedDeliveries = deliveries.map(d => ({
        ...d,
        valet_name: valetMap.get(d.valet_id) || "-",
        details: detailsByDeliveryId.get(d.id) || []
      }));
    }

    res.json({
      success: true,
      data: {
        header,
        details: details.map(d => {
          const parts = [d.master_linen_name, d.size_name, d.color_name, d.material_name].filter(Boolean);
          return {
            ...d,
            linen_display_name: d.item_name || d.hospital_linen_name || parts.join(" ")
          };
        }),
        auditLogs: enrichedLogs,
        kurangKirimDeliveries: enrichedDeliveries
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
      `INSERT INTO tr_komersil_linen_transaction_audit 
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
    "SELECT * FROM tr_komersil_linen_transaction WHERE id = ?",
    [transactionId]
  );
  if (!headers.length) return null;

  const [details] = await safeIKMQuery(
    `SELECT d.*, hl.hospital_linen_name,
            l.linen_name AS master_linen_name, sz.size_name, cl.color_name, mt.material_name
     FROM tr_komersil_linen_transaction_detail d
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
      return { ...d, linen_display_name: d.item_name || d.hospital_linen_name || parts.join(" ") };
    })
  };
}

// ── CRUD Endpoints ───────────────────────────────────────────────────────────
export const getEmployees = async (req, res) => {
  try {
    // company_id = 2 (IKM) diurutkan di atas, tapi nama di luar company tetap di-return
    const [rows] = await safeQuery(
      `SELECT employee_id, full_name, company_id
       FROM mst_employee
       WHERE exit_date IS NULL
       ORDER BY CASE WHEN company_id = 2 THEN 0 ELSE 1 END, full_name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getHospitalKomersilLinens = async (req, res) => {
  try {
    const hospitalId = Number(req.params.hospitalId);
    if (!hospitalId) {
      return res.status(400).json({ success: false, message: "Hospital ID invalid" });
    }
    const [rows] = await safeIKMQuery(
      `SELECT hl.id AS hospital_linen_id, hl.hospital_linen_name, hl.ownership_type,
              l.linen_name AS master_linen_name, l.category_id, sz.size_name, cl.color_name, mt.material_name
       FROM mst_hospital_linen hl
       LEFT JOIN mst_linen l ON l.id = hl.linen_id
       LEFT JOIN mst_size sz ON l.size_id = sz.id
       LEFT JOIN mst_color cl ON l.color_id = cl.id
       LEFT JOIN mst_material mt ON l.material_id = mt.id
       WHERE hl.hospital_id = ? AND hl.is_active = 1 AND hl.is_commercial = 1
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
  // Formulir komersil kini dibuat otomatis dari formulir serah terima induk (linen is_commercial)
  return res.status(400).json({
    success: false,
    message: "Formulir linen komersil dibuat otomatis dari Serah Terima Linen. Catat linen komersil di formulir serah terima."
  });
};

export const updateLinenTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    const [[head]] = await safeIKMQuery("SELECT parent_transaction_id FROM tr_komersil_linen_transaction WHERE id = ?", [id]);
    if (head?.parent_transaction_id) return updateKomersilChild(req, res);
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
      `UPDATE tr_komersil_linen_transaction 
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
      "DELETE FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ?",
      [id]
    );

    // Insert new details
    if (details && Array.isArray(details) && details.length > 0) {
      const detailValues = [];
      const queryParams = [];
      details.forEach(d => {
        detailValues.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        queryParams.push(
          id,
          d.hospital_linen_id ? Number(d.hospital_linen_id) : null,
          d.item_name || 'Linen Komersil',
          d.category || 'LAINNYA',
          Number(d.qty_kotor || 0),
          d.qty_bersih !== undefined && d.qty_bersih !== null ? Number(d.qty_bersih) : null,
          d.length_cm !== undefined && d.length_cm !== null ? parseFloat(d.length_cm) : null,
          d.width_cm !== undefined && d.width_cm !== null ? parseFloat(d.width_cm) : null,
          d.area_m2 !== undefined && d.area_m2 !== null ? parseFloat(d.area_m2) : null,
          Number(d.accessory_qty || 0)
        );
      });

      await safeIKMQuery(
        `INSERT INTO tr_komersil_linen_transaction_detail 
         (transaction_id, hospital_linen_id, item_name, category, qty_kotor, qty_bersih, length_cm, width_cm, area_m2, accessory_qty) 
         VALUES ${detailValues.join(", ")}`,
        queryParams
      );
    }

    // Capture new snapshot
    const newSnapshot = await getTransactionSnapshot(id);
    await writeAuditLog(id, "ADMIN", req, oldSnapshot, newSnapshot);

    res.json({ success: true, message: "Transaksi komersil berhasil diperbarui" });

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
    const [[head]] = await safeIKMQuery("SELECT parent_transaction_id FROM tr_komersil_linen_transaction WHERE id = ?", [id]);
    if (head?.parent_transaction_id) {
      return res.status(400).json({
        success: false,
        message: "Formulir komersil ini mengikuti formulir serah terima induknya. Hapus linen komersil dari formulir induk."
      });
    }
    // Tabel komersil tidak punya FK cascade: hapus rinciannya dulu
    await safeIKMQuery("DELETE FROM tr_komersil_linen_transaction_detail WHERE transaction_id = ?", [id]);

    // Delete header (cascades automatically delete details and audit logs)
    const [result] = await safeIKMQuery(
      "DELETE FROM tr_komersil_linen_transaction WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Transaksi tidak ditemukan" });
    }

    res.json({ success: true, message: "Transaksi komersil berhasil dihapus" });

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
      WHERE hl.is_active = 1 AND hl.is_commercial = 1 AND hl.hospital_id IN (${ph})
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
        d.length_cm,
        d.width_cm,
        d.area_m2,
        SUM(d.qty_kotor) as total_qty_kotor,
        SUM(d.qty_bersih) as total_qty_bersih
       FROM tr_komersil_linen_transaction tr
       JOIN tr_komersil_linen_transaction_detail d ON d.transaction_id = tr.id
       WHERE tr.hospital_id IN (${ph})
         AND tr.pickup_date >= ? 
         AND tr.pickup_date <= ?
       GROUP BY tr.hospital_id, DATE_FORMAT(tr.pickup_date, '%Y-%m-%d'), d.hospital_linen_id, d.length_cm, d.width_cm, d.area_m2`,
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
    let rawName = String(req.query.name || "").trim();
    if (!rawName) {
      return res.status(400).json({ success: false, message: "Parameter 'name' wajib diisi" });
    }

    const name = path.basename(rawName);

    // 1. In Development, check local folder first if configured or default local directory exists
    const localDir = process.env.IKM_SIGNATURE_LOCAL_DIR || "C:\\Users\\oemar\\Music\\PT Waschen Alora Indonesia\\linen-monitoring-system\\assets\\serahterimalinen";
    const localFilePath = path.join(localDir, name);
    const existsLocally = fs.existsSync(localFilePath);

    if (localDir && existsLocally) {
      const ext = path.extname(localFilePath).toLowerCase();
      const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".svg" ? "image/svg+xml" : "image/png";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=86400");
      const fileData = await fs.promises.readFile(localFilePath);
      return res.end(fileData);
    }

    // 2. Fetch from remote URL (Production or remote fallback)
    const baseUrl = process.env.IKM_SIGNATURE_BASE_URL || "https://linen.ikmalora.com/storage/assets/serahterimalinen";
    const targetUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;

    const upstream = await fetch(targetUrl, { method: "GET" });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, message: `Gagal memuat file (${upstream.status})` });
    }

    const contentType = upstream.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");

    const arrayBuf = await upstream.arrayBuffer();
    return res.end(Buffer.from(arrayBuf));
  } catch (err) {
    console.error("[proxySignature] Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
};

/**
 * Simpan formulir komersil berinduk: hanya qty bersih, P × L (tipe M2), catatan dan express.
 * Baris, kotor, TTD dan status mengikuti formulir serah terima induk. Bersih ditulis balik ke induk.
 */
async function updateKomersilChild(req, res) {
  const { id } = req.params;
  const { details = [], is_express } = req.body;
  const oldSnapshot = await getTransactionSnapshot(id);

  const [rows] = await safeIKMQuery(
    `SELECT d.*, COALESCE(hl.washing_price_type, 'PCS') AS washing_price_type
       FROM tr_komersil_linen_transaction_detail d
       LEFT JOIN mst_hospital_linen hl ON hl.id = d.hospital_linen_id
      WHERE d.transaction_id = ?`, [id]);
  const byId = new Map(rows.map(r => [String(r.id), r]));
  const num = (v) => (v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

  for (const item of details) {
    const row = byId.get(String(item.id));
    if (!row) continue;
    const kotor = Number(row.qty_kotor) || 0;
    let bersih = item.qty_bersih === undefined ? row.qty_bersih : num(item.qty_bersih);
    if (bersih !== null) bersih = Math.max(0, Math.min(kotor, Math.round(bersih)));
    let length = null, width = null, area = null;
    if (row.washing_price_type === "M2") {
      length = item.length_cm === undefined ? num(row.length_cm) : num(item.length_cm);
      width = item.width_cm === undefined ? num(row.width_cm) : num(item.width_cm);
      area = length && width ? Math.round(length * width * 100) / 100 : null;
    }
    await safeIKMQuery(
      `UPDATE tr_komersil_linen_transaction_detail
          SET qty_bersih = ?, length_cm = ?, width_cm = ?, area_m2 = ?, notes = ?
        WHERE id = ? AND transaction_id = ?`,
      [bersih, length, width, area, item.notes === undefined ? row.notes : (item.notes || null), row.id, id]);
  }
  if (is_express !== undefined) {
    await safeIKMQuery("UPDATE tr_komersil_linen_transaction SET is_express = ? WHERE id = ?",
      [is_express === true || is_express === 1 || is_express === "1" ? 1 : 0, id]);
  }
  await pushKomersilBersihToParent(id);

  const newSnapshot = await getTransactionSnapshot(id);
  await writeAuditLog(id, "ADMIN", req, oldSnapshot, newSnapshot);
  res.json({ success: true, message: "Formulir linen komersil berhasil diperbarui" });
}
