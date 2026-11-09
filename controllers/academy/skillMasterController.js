import { academyPool, safeAcademyQuery, safeMyWaschenQuery, safeQuery } from "../../db/pool.js";
import { validateSkillStructure } from "../../utils/academySkill.js";

const LO_COMPANY_ID = 1;

/** Bagian karyawan yang ada saat ini, langsung dari mst_role (DB my_waschen). */
async function getRoles() {
  const [rows] = await safeMyWaschenQuery(
    `SELECT DISTINCT role FROM mst_role WHERE role IS NOT NULL AND role <> '' ORDER BY role`
  );
  return rows.map((r) => r.role);
}

/** role_key kosong = posisi tidak terhubung ke bagian. Selain itu harus ada di mst_role. */
async function resolveRoleKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return { key: null };
  return (await getRoles()).includes(key) ? { key } : { error: "Bagian tidak ditemukan di data karyawan" };
}

const duplicateRoleMessage = (err) =>
  err.code === "ER_DUP_ENTRY" ? "Bagian ini sudah terhubung ke posisi lain" : null;

export const getRoleOptions = async (_req, res) => {
  try {
    res.json({ data: await getRoles() });
  } catch (err) {
    console.error("getRoleOptions error:", err);
    res.status(500).json({ message: "Gagal memuat daftar bagian" });
  }
};

export const getPositions = async (_req, res) => {
  try {
    const [positions] = await safeAcademyQuery(
      `SELECT id, name, role_key, is_active FROM mst_sm_position ORDER BY is_active DESC, sort_order, name`
    );
    const [categories] = await safeAcademyQuery(
      `SELECT id, position_id, name, weight FROM mst_sm_category WHERE is_active = 1 ORDER BY sort_order, id`
    );
    const [indicators] = await safeAcademyQuery(
      `SELECT id, category_id, name FROM mst_sm_indicator WHERE is_active = 1 ORDER BY sort_order, id`
    );

    res.json({
      data: positions.map((position) => ({
        ...position,
        categories: categories
          .filter((c) => c.position_id === position.id)
          .map((c) => ({ ...c, indicators: indicators.filter((i) => i.category_id === c.id) })),
      })),
    });
  } catch (err) {
    console.error("getPositions error:", err);
    res.status(500).json({ message: "Gagal memuat posisi" });
  }
};

export const createPosition = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama posisi wajib diisi" });

  try {
    const role = await resolveRoleKey(req.body.role_key);
    if (role.error) return res.status(400).json({ message: role.error });

    const [result] = await safeAcademyQuery(`INSERT INTO mst_sm_position (name, role_key, created_by) VALUES (?, ?, ?)`, [
      name,
      role.key,
      req.session.employeeId,
    ]);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (duplicateRoleMessage(err)) return res.status(400).json({ message: duplicateRoleMessage(err) });
    console.error("createPosition error:", err);
    res.status(500).json({ message: "Gagal menambah posisi" });
  }
};

export const updatePosition = async (req, res) => {
  const name = String(req.body.name ?? "").trim();
  if (!name) return res.status(400).json({ message: "Nama posisi wajib diisi" });

  try {
    const [result] = await safeAcademyQuery(`UPDATE mst_sm_position SET name = ?, is_active = ? WHERE id = ?`, [
      name,
      req.body.is_active ? 1 : 0,
      req.params.id,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: "Posisi tidak ditemukan" });

    // role_key hanya diubah kalau dikirim, supaya tombol aktif/nonaktif tidak memutus hubungannya.
    if ("role_key" in req.body) {
      const role = await resolveRoleKey(req.body.role_key);
      if (role.error) return res.status(400).json({ message: role.error });
      await safeAcademyQuery(`UPDATE mst_sm_position SET role_key = ? WHERE id = ?`, [role.key, req.params.id]);
    }
    res.json({ message: "Posisi diperbarui" });
  } catch (err) {
    if (duplicateRoleMessage(err)) return res.status(400).json({ message: duplicateRoleMessage(err) });
    console.error("updatePosition error:", err);
    res.status(500).json({ message: "Gagal memperbarui posisi" });
  }
};

async function saveIndicators(conn, categoryId, indicators, userId) {
  const [existing] = await conn.query(
    `SELECT id, name FROM mst_sm_indicator WHERE category_id = ? AND is_active = 1`,
    [categoryId]
  );
  const current = new Map(existing.map((row) => [row.id, row.name]));
  const keptIds = new Set(indicators.filter((i) => i.id).map((i) => Number(i.id)));

  for (const id of current.keys()) {
    if (!keptIds.has(id)) await conn.query(`UPDATE mst_sm_indicator SET is_active = 0 WHERE id = ?`, [id]);
  }

  for (const [order, indicator] of indicators.entries()) {
    const id = indicator.id ? Number(indicator.id) : null;
    const name = indicator.name.trim();

    if (id && !current.has(id)) return "Indikator tidak termasuk kategori ini";

    if (id) {
      const renamed = current.get(id) !== name;
      const [[usage]] = await conn.query(
        `SELECT COUNT(*) AS n FROM tr_sm_assessment_detail WHERE indicator_id = ?`,
        [id]
      );
      // Indikator yang sudah dinilai tidak diganti namanya, supaya rapor lama tetap menampilkan yang dinilai.
      if (!renamed || usage.n === 0) {
        await conn.query(`UPDATE mst_sm_indicator SET name = ?, sort_order = ? WHERE id = ?`, [name, order, id]);
        continue;
      }
      await conn.query(`UPDATE mst_sm_indicator SET is_active = 0 WHERE id = ?`, [id]);
    }

    await conn.query(
      `INSERT INTO mst_sm_indicator (category_id, name, sort_order, created_by) VALUES (?, ?, ?, ?)`,
      [categoryId, name, order, userId]
    );
  }
  return null;
}

export const saveStructure = async (req, res) => {
  const categories = req.body.categories ?? [];
  const validationError = validateSkillStructure(categories);
  if (validationError) return res.status(400).json({ message: validationError });

  const conn = await academyPool.getConnection();
  const abort = async (status, message) => {
    await conn.rollback();
    res.status(status).json({ message });
  };

  try {
    await conn.beginTransaction();
    const userId = req.session.employeeId;
    const positionId = req.params.id;

    const [[position]] = await conn.query(`SELECT id FROM mst_sm_position WHERE id = ? FOR UPDATE`, [positionId]);
    if (!position) return await abort(404, "Posisi tidak ditemukan");

    const [existing] = await conn.query(
      `SELECT id FROM mst_sm_category WHERE position_id = ? AND is_active = 1`,
      [positionId]
    );
    const currentIds = new Set(existing.map((row) => row.id));
    const keptIds = new Set(categories.filter((c) => c.id).map((c) => Number(c.id)));

    for (const id of currentIds) {
      if (!keptIds.has(id)) {
        await conn.query(`UPDATE mst_sm_category SET is_active = 0 WHERE id = ?`, [id]);
        await conn.query(`UPDATE mst_sm_indicator SET is_active = 0 WHERE category_id = ?`, [id]);
      }
    }

    for (const [order, category] of categories.entries()) {
      let categoryId = category.id ? Number(category.id) : null;

      if (categoryId) {
        if (!currentIds.has(categoryId)) return await abort(400, "Kategori tidak termasuk posisi ini");
        await conn.query(
          `UPDATE mst_sm_category SET name = ?, weight = ?, sort_order = ? WHERE id = ?`,
          [category.name.trim(), category.weight, order, categoryId]
        );
      } else {
        const [inserted] = await conn.query(
          `INSERT INTO mst_sm_category (position_id, name, weight, sort_order, created_by) VALUES (?, ?, ?, ?, ?)`,
          [positionId, category.name.trim(), category.weight, order, userId]
        );
        categoryId = inserted.insertId;
      }

      const indicatorError = await saveIndicators(conn, categoryId, category.indicators, userId);
      if (indicatorError) return await abort(400, indicatorError);
    }

    await conn.commit();
    res.json({ message: "Skill matrix tersimpan" });
  } catch (err) {
    await conn.rollback();
    console.error("saveStructure error:", err);
    res.status(500).json({ message: "Gagal menyimpan skill matrix" });
  } finally {
    conn.release();
  }
};

export const getLoOptions = async (_req, res) => {
  try {
    const [employees] = await safeQuery(
      `SELECT employee_id, full_name, employee_code FROM mst_employee
       WHERE company_id = ? AND is_deleted = 0 AND exit_date IS NULL
       ORDER BY full_name ASC`,
      [LO_COMPANY_ID]
    );
    const [outlets] = await safeQuery(`SELECT id, name FROM mst_outlet ORDER BY name ASC`);
    res.json({ employees, outlets });
  } catch (err) {
    console.error("getLoOptions error:", err);
    res.status(500).json({ message: "Gagal memuat pilihan LO" });
  }
};

export const getLoAssignments = async (_req, res) => {
  try {
    const [assignments] = await safeAcademyQuery(
      `SELECT id, employee_id, outlet_id, is_active FROM mst_lo_assignment ORDER BY is_active DESC, outlet_id, id`
    );
    if (!assignments.length) return res.json({ data: [] });

    const [employees] = await safeQuery(
      `SELECT employee_id, full_name, exit_date, is_deleted FROM mst_employee WHERE employee_id IN (?)`,
      [[...new Set(assignments.map((a) => a.employee_id))]]
    );
    const [outlets] = await safeQuery(`SELECT id, name FROM mst_outlet`);
    const employeeById = new Map(employees.map((e) => [e.employee_id, e]));
    const outletById = new Map(outlets.map((o) => [o.id, o.name]));

    res.json({
      data: assignments.map((a) => {
        const employee = employeeById.get(a.employee_id);
        return {
          ...a,
          full_name: employee?.full_name ?? "Karyawan tidak ditemukan",
          employee_inactive: !employee || Boolean(employee.exit_date) || Boolean(employee.is_deleted),
          outlet_name: outletById.get(a.outlet_id) ?? "Cabang tidak ditemukan",
        };
      }),
    });
  } catch (err) {
    console.error("getLoAssignments error:", err);
    res.status(500).json({ message: "Gagal memuat daftar LO" });
  }
};

export const createLoAssignment = async (req, res) => {
  const { employee_id, outlet_id } = req.body;
  if (!employee_id || !outlet_id) return res.status(400).json({ message: "Karyawan dan cabang wajib dipilih" });

  try {
    const [employees] = await safeQuery(
      `SELECT employee_id FROM mst_employee
       WHERE employee_id = ? AND company_id = ? AND is_deleted = 0 AND exit_date IS NULL LIMIT 1`,
      [employee_id, LO_COMPANY_ID]
    );
    if (!employees.length) return res.status(400).json({ message: "LO harus karyawan aktif PT Waschen Alora Indonesia" });

    const [outlets] = await safeQuery(`SELECT id FROM mst_outlet WHERE id = ? LIMIT 1`, [outlet_id]);
    if (!outlets.length) return res.status(400).json({ message: "Cabang tidak ditemukan" });

    await safeAcademyQuery(
      `INSERT INTO mst_lo_assignment (employee_id, outlet_id, created_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [employee_id, outlet_id, req.session.employeeId]
    );
    res.status(201).json({ message: "LO ditugaskan" });
  } catch (err) {
    console.error("createLoAssignment error:", err);
    res.status(500).json({ message: "Gagal menugaskan LO" });
  }
};

export const updateLoAssignment = async (req, res) => {
  try {
    const [result] = await safeAcademyQuery(`UPDATE mst_lo_assignment SET is_active = ? WHERE id = ?`, [
      req.body.is_active ? 1 : 0,
      req.params.id,
    ]);
    if (!result.affectedRows) return res.status(404).json({ message: "Penugasan LO tidak ditemukan" });
    res.json({ message: "Penugasan LO diperbarui" });
  } catch (err) {
    console.error("updateLoAssignment error:", err);
    res.status(500).json({ message: "Gagal memperbarui penugasan LO" });
  }
};
