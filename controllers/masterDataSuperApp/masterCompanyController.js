import { safeQuery } from "../../db/pool.js";

export const getCompanies = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_company ORDER BY company_name ASC`);
    res.json({ companies: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getCompanyById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_company WHERE company_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Company tidak ditemukan" });
    res.json({ company: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createCompany = async (req, res) => {
  const { company_code, company_name, is_active = 1 } = req.body;
  if (!company_code?.trim()) return res.status(400).json({ message: "Kode company wajib diisi" });
  if (!company_name?.trim()) return res.status(400).json({ message: "Nama company wajib diisi" });
  try {
    const [exist] = await safeQuery(`SELECT company_id FROM mst_company WHERE company_code = ?`, [company_code.trim()]);
    if (exist.length) return res.status(409).json({ message: "Kode company sudah digunakan" });
    const [r] = await safeQuery(
      `INSERT INTO mst_company (company_code, company_name, is_active) VALUES (?, ?, ?)`,
      [company_code.trim().toUpperCase(), company_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Company berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateCompany = async (req, res) => {
  const { company_code, company_name, is_active } = req.body;
  if (!company_code?.trim()) return res.status(400).json({ message: "Kode company wajib diisi" });
  if (!company_name?.trim()) return res.status(400).json({ message: "Nama company wajib diisi" });
  try {
    const [exist] = await safeQuery(
      `SELECT company_id FROM mst_company WHERE company_code = ? AND company_id != ?`,
      [company_code.trim(), req.params.id]
    );
    if (exist.length) return res.status(409).json({ message: "Kode company sudah digunakan" });
    await safeQuery(
      `UPDATE mst_company SET company_code = ?, company_name = ?, is_active = ? WHERE company_id = ?`,
      [company_code.trim().toUpperCase(), company_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Company berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteCompany = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_company WHERE company_id = ?`, [req.params.id]);
    res.json({ message: "Company berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
