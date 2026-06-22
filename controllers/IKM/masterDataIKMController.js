import { safeIKMQuery } from "../../db/pool.js";

/* ── helpers ── */
function crud(table, sortCol) {
  const getAll = async (req, res) => {
    try {
      const [rows] = await safeIKMQuery(`SELECT * FROM ${table} ORDER BY ${sortCol} ASC`);
      res.json(rows);
    } catch (err) {
      console.error(`getAll(${table}):`, err);
      res.status(500).json({ message: err.message });
    }
  };
  const create = async (req, res) => {
    try {
      const cols = Object.keys(req.body).join(", ");
      const vals = Object.values(req.body);
      const ph = vals.map(() => "?").join(", ");
      const [r] = await safeIKMQuery(`INSERT INTO ${table} (${cols}) VALUES (${ph})`, vals);
      res.status(201).json({ message: "Berhasil ditambahkan", id: r.insertId });
    } catch (err) {
      console.error(`create(${table}):`, err);
      res.status(500).json({ message: err.message });
    }
  };
  const update = async (req, res) => {
    try {
      const { id } = req.params;
      const sets = Object.keys(req.body).map(k => `${k} = ?`).join(", ");
      const vals = [...Object.values(req.body), id];
      await safeIKMQuery(`UPDATE ${table} SET ${sets} WHERE id = ?`, vals);
      res.json({ message: "Berhasil diperbarui" });
    } catch (err) {
      console.error(`update(${table}):`, err);
      res.status(500).json({ message: err.message });
    }
  };
  const remove = async (req, res) => {
    try {
      const { id } = req.params;
      await safeIKMQuery(`DELETE FROM ${table} WHERE id = ?`, [id]);
      res.json({ message: "Berhasil dihapus" });
    } catch (err) {
      console.error(`remove(${table}):`, err);
      res.status(500).json({ message: err.message });
    }
  };
  return { getAll, create, update, remove };
}

const sizes = crud("mst_size", "sort_order");
const colors = crud("mst_color", "sort_order");
const materials = crud("mst_material", "material_name");
const categories = crud("mst_linen_category", "sort_order");
const vendors = crud("mst_vendor_ikm", "nama_vendor");

export const getSizesMD = sizes.getAll;
export const createSize = sizes.create;
export const updateSize = sizes.update;
export const deleteSize = sizes.remove;

export const getColorsMD = colors.getAll;
export const createColor = colors.create;
export const updateColor = colors.update;
export const deleteColor = colors.remove;

export const getMaterialsMD = materials.getAll;
export const createMaterial = materials.create;
export const updateMaterial = materials.update;
export const deleteMaterial = materials.remove;

export const getLinenCategories = categories.getAll;
export const createLinenCategory = categories.create;
export const updateLinenCategory = categories.update;
export const deleteLinenCategory = categories.remove;

export const getVendorsMD = vendors.getAll;
export const createVendor = vendors.create;
export const updateVendor = vendors.update;
export const deleteVendor = vendors.remove;
