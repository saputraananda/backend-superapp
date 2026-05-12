import { safeQuery } from "../../db/pool.js";

export const getJobLevels = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_job_level ORDER BY job_level_name ASC`);
    res.json({ jobLevels: rows });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const getJobLevelById = async (req, res) => {
  try {
    const [rows] = await safeQuery(`SELECT * FROM mst_job_level WHERE job_level_id = ?`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: "Level jabatan tidak ditemukan" });
    res.json({ jobLevel: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const createJobLevel = async (req, res) => {
  const { company_code, job_level_name, is_active = 1 } = req.body;
  if (!job_level_name?.trim()) return res.status(400).json({ message: "Nama level jabatan wajib diisi" });
  try {
    const [r] = await safeQuery(
      `INSERT INTO mst_job_level (company_code, job_level_name, is_active) VALUES (?, ?, ?)`,
      [company_code?.trim() || null, job_level_name.trim(), is_active ? 1 : 0]
    );
    res.status(201).json({ message: "Level jabatan berhasil ditambahkan", id: r.insertId });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const updateJobLevel = async (req, res) => {
  const { company_code, job_level_name, is_active } = req.body;
  if (!job_level_name?.trim()) return res.status(400).json({ message: "Nama level jabatan wajib diisi" });
  try {
    await safeQuery(
      `UPDATE mst_job_level SET company_code = ?, job_level_name = ?, is_active = ? WHERE job_level_id = ?`,
      [company_code?.trim() || null, job_level_name.trim(), is_active ? 1 : 0, req.params.id]
    );
    res.json({ message: "Level jabatan berhasil diperbarui" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

export const deleteJobLevel = async (req, res) => {
  try {
    await safeQuery(`DELETE FROM mst_job_level WHERE job_level_id = ?`, [req.params.id]);
    res.json({ message: "Level jabatan berhasil dihapus" });
  } catch (err) { res.status(500).json({ message: err.message }); }
};
