import { safeMyWaschenQuery } from "../../../db/pool.js";

const SORT_COLUMNS = ["id", "code", "name", "tier", "top_up_amount", "validity_days", "created_at"];
const TIERS = ["Gold", "Diamond"];

export const getMembershipPackages = async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const tier = req.query.tier;
    const isActive = req.query.isActive;
    const sortBy = SORT_COLUMNS.includes(req.query.sortBy) ? req.query.sortBy : "top_up_amount";
    const sortDir = String(req.query.sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";

    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    if (tier && TIERS.includes(tier)) {
      where.push("tier = ?");
      params.push(tier);
    }

    if (isActive !== undefined && isActive !== "") {
      where.push("is_active = ?");
      params.push(Number(isActive));
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await safeMyWaschenQuery(
      `SELECT * FROM mst_membership_package ${whereSql} ORDER BY ${sortBy} ${sortDir}, name ASC`,
      params
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMembershipPackages error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getMembershipPackageById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeMyWaschenQuery("SELECT * FROM mst_membership_package WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Paket membership tidak ditemukan" });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("getMembershipPackageById error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createMembershipPackage = async (req, res) => {
  try {
    const { code, name, tier, top_up_amount, validity_days, description, is_active } = req.body;

    if (!code?.trim() || !name?.trim() || !top_up_amount) {
      return res.status(400).json({ success: false, message: "Kode, Nama Paket, dan Nominal Top Up wajib diisi" });
    }

    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const packageTier = TIERS.includes(tier) ? tier : "Gold";

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_membership_package WHERE code = ?", [formattedCode]);
    if (exist.length) {
      return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
    }

    const [result] = await safeMyWaschenQuery(
      `INSERT INTO mst_membership_package (code, name, tier, top_up_amount, validity_days, description, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        formattedCode,
        name.trim(),
        packageTier,
        Number(top_up_amount) || 0,
        Number(validity_days) || 180,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
      ]
    );

    res.status(201).json({ success: true, message: "Paket membership berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createMembershipPackage error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateMembershipPackage = async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, tier, top_up_amount, validity_days, description, is_active } = req.body;

    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_membership_package WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Paket membership tidak ditemukan" });
    }

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Nama Paket wajib diisi" });
    }

    const formattedCode = code?.trim() ? code.trim().toUpperCase().replace(/\s+/g, "_") : null;
    if (formattedCode) {
      const [dup] = await safeMyWaschenQuery(
        "SELECT id FROM mst_membership_package WHERE code = ? AND id != ?",
        [formattedCode, id]
      );
      if (dup.length) {
        return res.status(400).json({ success: false, message: `Kode "${formattedCode}" sudah digunakan` });
      }
    }

    const packageTier = TIERS.includes(tier) ? tier : "Gold";

    await safeMyWaschenQuery(
      `UPDATE mst_membership_package
       SET code = COALESCE(?, code),
           name = ?,
           tier = ?,
           top_up_amount = ?,
           validity_days = ?,
           description = ?,
           is_active = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        formattedCode,
        name.trim(),
        packageTier,
        Number(top_up_amount) || 0,
        Number(validity_days) || 180,
        description?.trim() || null,
        is_active !== undefined ? Number(is_active) : 1,
        id,
      ]
    );

    res.json({ success: true, message: "Paket membership berhasil diperbarui" });
  } catch (err) {
    console.error("updateMembershipPackage error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteMembershipPackage = async (req, res) => {
  try {
    const { id } = req.params;
    const [exist] = await safeMyWaschenQuery("SELECT id FROM mst_membership_package WHERE id = ?", [id]);
    if (!exist.length) {
      return res.status(404).json({ success: false, message: "Paket membership tidak ditemukan" });
    }

    const [used] = await safeMyWaschenQuery("SELECT id FROM tr_membership WHERE package_id = ? LIMIT 1", [id]);
    if (used.length) {
      return res.status(400).json({ success: false, message: "Paket tidak dapat dihapus karena sudah digunakan membership pelanggan" });
    }

    await safeMyWaschenQuery("DELETE FROM mst_membership_package WHERE id = ?", [id]);
    res.json({ success: true, message: "Paket membership berhasil dihapus" });
  } catch (err) {
    console.error("deleteMembershipPackage error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};
