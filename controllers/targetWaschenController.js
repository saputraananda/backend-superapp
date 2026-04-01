import { safeSmartlinkQuery } from "../db/pool.js";

// ══════════════════════════════════════════════════════════════════
// TARGET SALES  (tabel: target_sales)
// ══════════════════════════════════════════════════════════════════

export const getTargetSales = async (req, res) => {
  try {
    const { tahun, bulan } = req.query;
    let sql = "SELECT id, outlet, tahun, bulan, nominal, created_at, updated_at FROM target_sales";
    const params = [];
    const conditions = [];
    if (tahun) { conditions.push("tahun = ?"); params.push(Number(tahun)); }
    if (bulan) { conditions.push("bulan = ?"); params.push(Number(bulan)); }
    if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY tahun DESC, bulan DESC, outlet";
    const [rows] = await safeSmartlinkQuery(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createTargetSales = async (req, res) => {
  const { outlet, tahun, bulan, nominal } = req.body;
  if (!outlet || !tahun || !bulan || nominal === undefined || nominal === null)
    return res.status(400).json({ message: "outlet, tahun, bulan, dan nominal wajib diisi" });
  if (Number(bulan) < 1 || Number(bulan) > 12)
    return res.status(400).json({ message: "bulan harus antara 1-12" });
  try {
    await safeSmartlinkQuery(
      "INSERT INTO target_sales (outlet, tahun, bulan, nominal) VALUES (?, ?, ?, ?)",
      [outlet.trim(), Number(tahun), Number(bulan), Number(nominal)]
    );
    res.status(201).json({ message: "Target sales berhasil ditambahkan" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ message: "Target untuk outlet, tahun, dan bulan ini sudah ada" });
    res.status(500).json({ message: err.message });
  }
};

export const updateTargetSales = async (req, res) => {
  const { id } = req.params;
  const { outlet, tahun, bulan, nominal } = req.body;
  if (!outlet || !tahun || !bulan || nominal === undefined || nominal === null)
    return res.status(400).json({ message: "outlet, tahun, bulan, dan nominal wajib diisi" });
  if (Number(bulan) < 1 || Number(bulan) > 12)
    return res.status(400).json({ message: "bulan harus antara 1-12" });
  try {
    await safeSmartlinkQuery(
      "UPDATE target_sales SET outlet = ?, tahun = ?, bulan = ?, nominal = ? WHERE id = ?",
      [outlet.trim(), Number(tahun), Number(bulan), Number(nominal), id]
    );
    res.json({ message: "Target sales berhasil diperbarui" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY")
      return res.status(409).json({ message: "Target untuk outlet, tahun, dan bulan ini sudah ada" });
    res.status(500).json({ message: err.message });
  }
};

export const deleteTargetSales = async (req, res) => {
  const { id } = req.params;
  try {
    await safeSmartlinkQuery("DELETE FROM target_sales WHERE id = ?", [id]);
    res.json({ message: "Target sales berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════
// TARGET CUSTOMER  (tabel: target_customer)
// ══════════════════════════════════════════════════════════════════

export const getTargetCustomer = async (_req, res) => {
  try {
    const [rows] = await safeSmartlinkQuery(
      "SELECT id, tahun, jumlah, created_at, updated_at FROM target_customer ORDER BY tahun DESC"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createTargetCustomer = async (req, res) => {
  const { tahun, jumlah } = req.body;
  if (!tahun || jumlah === undefined || jumlah === null)
    return res.status(400).json({ message: "tahun dan jumlah wajib diisi" });
  try {
    await safeSmartlinkQuery(
      "INSERT INTO target_customer (tahun, jumlah) VALUES (?, ?)",
      [Number(tahun), Number(jumlah)]
    );
    res.status(201).json({ message: "Target customer berhasil ditambahkan" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateTargetCustomer = async (req, res) => {
  const { id } = req.params;
  const { tahun, jumlah } = req.body;
  if (!tahun || jumlah === undefined || jumlah === null)
    return res.status(400).json({ message: "tahun dan jumlah wajib diisi" });
  try {
    await safeSmartlinkQuery(
      "UPDATE target_customer SET tahun = ?, jumlah = ? WHERE id = ?",
      [Number(tahun), Number(jumlah), id]
    );
    res.json({ message: "Target customer berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteTargetCustomer = async (req, res) => {
  const { id } = req.params;
  try {
    await safeSmartlinkQuery("DELETE FROM target_customer WHERE id = ?", [id]);
    res.json({ message: "Target customer berhasil dihapus" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};