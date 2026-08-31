import { safeMyWaschenQuery } from "../../../db/pool.js";

export const FIELD_LABELS = [
  { key: "show_outlet_name", label: "Nama Outlet" },
  { key: "show_datetime", label: "Tanggal / Waktu" },
  { key: "show_customer_name", label: "Nama Pelanggan" },
  { key: "show_customer_phone", label: "No. Telepon" },
  { key: "show_customer_address", label: "Alamat Pelanggan" },
  { key: "show_cashier", label: "Nama Kasir" },
  { key: "show_item_price", label: "Harga Item" },
  { key: "show_item_detail", label: "Detail Item (merk/warna/ukuran)" },
  { key: "show_perfume", label: "Aroma Parfum" },
  { key: "show_express", label: "Tipe Pengerjaan" },
  { key: "show_delivery", label: "Tipe Pengambilan" },
  { key: "show_discount", label: "Diskon Promo" },
  { key: "show_total", label: "Total Tagihan" },
  { key: "show_payment", label: "Rincian Pembayaran" },
  { key: "show_member_balance", label: "Saldo Member" },
  { key: "show_notes", label: "Catatan Order" },
  { key: "show_qr", label: "QR Tracking" },
  { key: "show_perhatian", label: "Syarat & Ketentuan" },
  { key: "show_footer_thanks", label: "Footer Terima Kasih" },
];

const TOGGLE_KEYS = FIELD_LABELS.map((f) => f.key);

export const DEFAULT_CUSTOMER_SETTINGS = {
  show_outlet_name: 1,
  show_datetime: 1,
  show_customer_name: 1,
  show_customer_phone: 1,
  show_customer_address: 1,
  show_cashier: 1,
  show_item_price: 1,
  show_item_detail: 1,
  show_perfume: 1,
  show_express: 1,
  show_delivery: 1,
  show_discount: 1,
  show_total: 1,
  show_payment: 1,
  show_member_balance: 1,
  show_notes: 1,
  show_qr: 1,
  show_perhatian: 1,
  show_footer_thanks: 1,
};

export const DEFAULT_INTERNAL_SETTINGS = {
  show_outlet_name: 1,
  show_datetime: 1,
  show_customer_name: 1,
  show_customer_phone: 1,
  show_customer_address: 0,
  show_cashier: 1,
  show_item_price: 0,
  show_item_detail: 1,
  show_perfume: 1,
  show_express: 1,
  show_delivery: 1,
  show_discount: 0,
  show_total: 0,
  show_payment: 0,
  show_member_balance: 0,
  show_notes: 1,
  show_qr: 1,
  show_perhatian: 0,
  show_footer_thanks: 0,
};

function pickSettings(row, fallback) {
  const out = { ...fallback };
  if (!row) return out;
  for (const key of TOGGLE_KEYS) {
    if (row[key] != null) out[key] = Number(row[key]) === 1 ? 1 : 0;
  }
  return out;
}

function normalizeOutletId(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** GET /waschen/printer-settings?outletId= */
export const getPrinterSettings = async (req, res) => {
  try {
    const outletId = normalizeOutletId(req.query.outletId ?? req.query.outlet_id ?? 0);

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_thermal_nota_setting
       WHERE outlet_id IN (?, 0)
       ORDER BY FIELD(outlet_id, ?) DESC, nota_type ASC`,
      [outletId, outletId]
    );

    const customerRow = rows.find((r) => r.nota_type === "customer" && Number(r.outlet_id) === outletId)
      || rows.find((r) => r.nota_type === "customer" && Number(r.outlet_id) === 0);
    const internalRow = rows.find((r) => r.nota_type === "internal" && Number(r.outlet_id) === outletId)
      || rows.find((r) => r.nota_type === "internal" && Number(r.outlet_id) === 0);

    res.json({
      success: true,
      data: {
        outletId,
        customer: pickSettings(customerRow, DEFAULT_CUSTOMER_SETTINGS),
        internal: pickSettings(internalRow, DEFAULT_INTERNAL_SETTINGS),
        fieldLabels: FIELD_LABELS,
      },
    });
  } catch (err) {
    console.error("getPrinterSettings error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

function sanitizeSettings(input, fallback) {
  const out = { ...fallback };
  if (!input || typeof input !== "object") return out;
  for (const key of TOGGLE_KEYS) {
    if (input[key] != null) out[key] = Number(input[key]) === 1 ? 1 : 0;
  }
  return out;
}

async function upsertNotaSetting(outletId, notaType, settings) {
  const cols = TOGGLE_KEYS.join(", ");
  const placeholders = TOGGLE_KEYS.map(() => "?").join(", ");
  const updates = TOGGLE_KEYS.map((k) => `${k} = VALUES(${k})`).join(", ");

  const params = [outletId, notaType, ...TOGGLE_KEYS.map((k) => settings[k])];

  await safeMyWaschenQuery(
    `INSERT INTO mst_thermal_nota_setting (outlet_id, nota_type, ${cols})
     VALUES (?, ?, ${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}, updated_at = NOW()`,
    params
  );
}

/** PUT /waschen/printer-settings */
export const savePrinterSettings = async (req, res) => {
  try {
    const outletId = normalizeOutletId(req.body?.outletId ?? req.body?.outlet_id ?? 0);
    const customer = sanitizeSettings(req.body?.customer, DEFAULT_CUSTOMER_SETTINGS);
    const internal = sanitizeSettings(req.body?.internal, DEFAULT_INTERNAL_SETTINGS);

    await upsertNotaSetting(outletId, "customer", customer);
    await upsertNotaSetting(outletId, "internal", internal);

    res.json({
      success: true,
      message: "Pengaturan nota berhasil disimpan",
      data: { outletId, customer, internal, fieldLabels: FIELD_LABELS },
    });
  } catch (err) {
    console.error("savePrinterSettings error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

/** GET /waschen/printer-settings/preview-receipt?outletId= */
export const getPreviewReceipt = async (req, res) => {
  try {
    const outletId = req.query.outletId ? Number(req.query.outletId) : null;

    const where = [];
    const params = [];
    if (outletId) {
      where.push("t.outlet_id = ?");
      params.push(outletId);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [txRows] = await safeMyWaschenQuery(
      `SELECT t.id, t.order_no FROM tr_transaction t ${whereSql} ORDER BY t.order_date DESC LIMIT 1`,
      params
    );

    if (!txRows.length) {
      return res.json({ success: true, data: null, message: "Belum ada transaksi untuk preview" });
    }

    res.json({
      success: true,
      data: { orderNo: txRows[0].order_no, transactionId: txRows[0].id },
    });
  } catch (err) {
    console.error("getPreviewReceipt error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
