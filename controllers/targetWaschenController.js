import { safeSmartlinkQuery } from "../db/pool.js";

// ══════════════════════════════════════════════════════════════════
// TARGET SALES  (tabel: target)
// ══════════════════════════════════════════════════════════════════

export const getTargetSales = async (_req, res) => {
  try {
    const [rows] = await safeSmartlinkQuery(
      "SELECT outlet, nominal FROM target ORDER BY outlet"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const createTargetSales = async (req, res) => {
  const { outlet, nominal } = req.body;
  if (!outlet || nominal === undefined || nominal === null)
    return res.status(400).json({ message: "outlet dan nominal wajib diisi" });
  try {
    await safeSmartlinkQuery(
      "INSERT INTO target (outlet, nominal) VALUES (?, ?)",
      [outlet.trim(), Number(nominal)]
    );
    res.status(201).json({ message: "Target sales berhasil ditambahkan" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const updateTargetSales = async (req, res) => {
  const { outlet } = req.params;           // outlet lama (sebagai kunci)
  const { outlet: newOutlet, nominal } = req.body;
  if (!newOutlet || nominal === undefined || nominal === null)
    return res.status(400).json({ message: "outlet dan nominal wajib diisi" });
  try {
    await safeSmartlinkQuery(
      "UPDATE target SET outlet = ?, nominal = ? WHERE outlet = ?",
      [newOutlet.trim(), Number(nominal), outlet]
    );
    res.json({ message: "Target sales berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

export const deleteTargetSales = async (req, res) => {
  const { outlet } = req.params;
  try {
    await safeSmartlinkQuery("DELETE FROM target WHERE outlet = ?", [outlet]);
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