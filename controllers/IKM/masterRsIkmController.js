import { safeIKMQuery, safeQuery } from "../../db/pool.js";

const parseCoord = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

const parsePrice = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const calcChangePercent = (oldPrice, newPrice) => {
  if (oldPrice == null || Number(oldPrice) === 0) return null;
  if (newPrice == null) return null;
  return Number((((Number(newPrice) - Number(oldPrice)) / Number(oldPrice)) * 100).toFixed(2));
};

const pricesEqual = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Number(a) === Number(b);
};

async function resolveActor(req) {
  let userId = null;
  let username = "system";
  let fullName = "System Admin";

  try {
    if (req.session?.userEmail) {
      const [empRows] = await safeQuery(
        "SELECT employee_id, full_name, email FROM mst_employee WHERE email = ? LIMIT 1",
        [req.session.userEmail]
      );
      if (empRows.length) {
        userId = empRows[0].employee_id;
        username = req.session.userName || empRows[0].email;
        fullName = empRows[0].full_name;
        return { userId, username, fullName };
      }
      userId = req.session.userId || null;
      username = req.session.userName || req.session.userEmail || "system";
      fullName = req.session.userName || "System Admin";
      return { userId, username, fullName };
    }

    userId = req.session?.user?.id || req.session?.user?.user_id || req.user?.id || null;
    username = req.session?.user?.username || req.session?.user?.email || req.user?.username || "system";
    fullName =
      req.session?.user?.employee?.full_name ||
      req.session?.user?.name ||
      req.user?.full_name ||
      "System Admin";
  } catch (err) {
    console.warn("resolveActor:", err.message);
  }

  return { userId, username, fullName };
}

async function insertPriceLog(hospitalId, oldPrice, newPrice, actor, priceType = "REGULER") {
  const changePercent = calcChangePercent(oldPrice, newPrice);
  await safeIKMQuery(
    `INSERT INTO tr_hospital_kg_price_log
       (hospital_id, price_type, old_price, new_price, change_percent, user_id, username, full_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hospitalId,
      priceType,
      oldPrice,
      newPrice,
      changePercent,
      actor.userId,
      actor.username,
      actor.fullName,
    ]
  );
}

// ── GET ALL ────────────────────────────────────────────────────────────────
export const getHospitals = async (req, res) => {
  try {
    const [rows] = await safeIKMQuery(
      `SELECT id, hospital_name, hospital_id, company_name, address,
              latitude, longitude, username, password, username_unit, password_unit, password_to_valet,
              billing_by_kg, allow_express, price_per_kg, express_price_per_kg, kg_agreement, created_at, updated_at
       FROM mst_hospital
       ORDER BY hospital_name ASC`
    );

    const [roomRows] = await safeIKMQuery(
      `SELECT id, hospital_id, room_name, is_gudang_linen, is_special_unit FROM mst_rooms_rs ORDER BY room_name ASC`
    );

    const roomsMap = {};
    roomRows.forEach((r) => {
      if (!roomsMap[r.hospital_id]) roomsMap[r.hospital_id] = [];
      roomsMap[r.hospital_id].push(r);
    });

    const data = rows.map((h) => ({
      ...h,
      rooms: roomsMap[h.id] || [],
    }));

    res.json({ data });
  } catch (err) {
    console.error("getHospitals:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── GET price history ──────────────────────────────────────────────────────
export const getHospitalKgPriceLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await safeIKMQuery(
      `SELECT id, hospital_id, price_type, old_price, new_price, change_percent,
              user_id, username, full_name, created_at
       FROM tr_hospital_kg_price_log
       WHERE hospital_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getHospitalKgPriceLogs:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── CREATE ─────────────────────────────────────────────────────────────────
export const createHospital = async (req, res) => {
  const {
    hospital_name,
    hospital_id,
    company_name,
    address,
    latitude,
    longitude,
    username,
    password,
    username_unit,
    password_unit,
    password_to_valet,
    billing_by_kg,
    allow_express,
    price_per_kg,
    express_price_per_kg,
    kg_agreement,
    rooms,
  } = req.body;

  if (!hospital_name?.trim())
    return res.status(400).json({ message: "Nama rumah sakit wajib diisi" });

  const pricePerKg = parsePrice(price_per_kg);
  if (billing_by_kg && (pricePerKg == null || pricePerKg < 0)) {
    return res.status(400).json({ message: "Harga per kilogram wajib diisi jika billing kilogram aktif" });
  }
  const expressPricePerKg = parsePrice(express_price_per_kg);
  if (expressPricePerKg != null && expressPricePerKg < 0) {
    return res.status(400).json({ message: "Harga express per kilogram tidak boleh negatif" });
  }
  // Opsional; hanya berlaku untuk RS billing kilogram
  const kgAgreement = billing_by_kg ? parsePrice(kg_agreement) : null;
  if (kgAgreement != null && kgAgreement < 0) {
    return res.status(400).json({ message: "Kg perjanjian tidak boleh negatif" });
  }

  try {
    const [dupName] = await safeIKMQuery(
      `SELECT id FROM mst_hospital WHERE hospital_name = ?`,
      [hospital_name.trim()]
    );
    if (dupName.length > 0)
      return res.status(409).json({ message: "Nama rumah sakit sudah terdaftar" });

    if (hospital_id?.trim()) {
      const [dupId] = await safeIKMQuery(
        `SELECT id FROM mst_hospital WHERE hospital_id = ?`,
        [hospital_id.trim()]
      );
      if (dupId.length > 0)
        return res.status(409).json({ message: "Hospital ID sudah digunakan" });
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO mst_hospital
         (hospital_name, hospital_id, company_name, address, latitude, longitude,
          username, password, username_unit, password_unit, password_to_valet,
          billing_by_kg, allow_express, price_per_kg, express_price_per_kg, kg_agreement)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
        username?.trim() || null,
        password || null,
        username_unit?.trim() || null,
        password_unit || null,
        password_to_valet || null,
        billing_by_kg ? 1 : 0,
        allow_express ? 1 : 0,
        pricePerKg,
        expressPricePerKg,
        kgAgreement,
      ]
    );

    if (pricePerKg != null || expressPricePerKg != null) {
      const actor = await resolveActor(req);
      if (pricePerKg != null) await insertPriceLog(result.insertId, null, pricePerKg, actor, "REGULER");
      if (expressPricePerKg != null) await insertPriceLog(result.insertId, null, expressPricePerKg, actor, "EXPRESS");
    }

    if (Array.isArray(rooms) && rooms.length > 0) {
      const gudangLinenCount = rooms.filter((r) =>
        typeof r === "object" && r !== null ? r.is_gudang_linen : false
      ).length;
      if (gudangLinenCount > 1) {
        return res.status(400).json({ message: "Hanya diperbolehkan maksimal 1 ruangan sebagai gudang linen" });
      }

      for (const room of rooms) {
        const isObj = typeof room === "object" && room !== null;
        const name = (isObj ? room.room_name : room)?.trim();
        const isGudangLinen = isObj ? (room.is_gudang_linen ? 1 : 0) : 0;
        const isSpecialUnit = isObj ? (room.is_special_unit ? 1 : 0) : 0;
        if (name) {
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name, is_gudang_linen, is_special_unit) VALUES (?, ?, ?, ?)`,
            [result.insertId, name, isGudangLinen, isSpecialUnit]
          );
        }
      }
    }

    res.status(201).json({ message: "Rumah sakit berhasil ditambahkan", id: result.insertId });
  } catch (err) {
    console.error("createHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── UPDATE ─────────────────────────────────────────────────────────────────
export const updateHospital = async (req, res) => {
  const { id } = req.params;
  const {
    hospital_name,
    hospital_id,
    company_name,
    address,
    latitude,
    longitude,
    username,
    password,
    username_unit,
    password_unit,
    password_to_valet,
    billing_by_kg,
    allow_express,
    price_per_kg,
    express_price_per_kg,
    kg_agreement,
    rooms,
  } = req.body;

  if (!hospital_name?.trim())
    return res.status(400).json({ message: "Nama rumah sakit wajib diisi" });

  const pricePerKg = parsePrice(price_per_kg);
  if (billing_by_kg && (pricePerKg == null || pricePerKg < 0)) {
    return res.status(400).json({ message: "Harga per kilogram wajib diisi jika billing kilogram aktif" });
  }
  const expressPricePerKg = parsePrice(express_price_per_kg);
  if (expressPricePerKg != null && expressPricePerKg < 0) {
    return res.status(400).json({ message: "Harga express per kilogram tidak boleh negatif" });
  }
  // Opsional; hanya berlaku untuk RS billing kilogram
  const kgAgreement = billing_by_kg ? parsePrice(kg_agreement) : null;
  if (kgAgreement != null && kgAgreement < 0) {
    return res.status(400).json({ message: "Kg perjanjian tidak boleh negatif" });
  }

  try {
    const [exist] = await safeIKMQuery(
      `SELECT id, price_per_kg, express_price_per_kg FROM mst_hospital WHERE id = ?`,
      [id]
    );
    if (exist.length === 0)
      return res.status(404).json({ message: "Rumah sakit tidak ditemukan" });

    const oldPrice = exist[0].price_per_kg != null ? Number(exist[0].price_per_kg) : null;
    const oldExpressPrice =
      exist[0].express_price_per_kg != null ? Number(exist[0].express_price_per_kg) : null;

    const [dupName] = await safeIKMQuery(
      `SELECT id FROM mst_hospital WHERE hospital_name = ? AND id != ?`,
      [hospital_name.trim(), id]
    );
    if (dupName.length > 0)
      return res.status(409).json({ message: "Nama rumah sakit sudah digunakan" });

    if (hospital_id?.trim()) {
      const [dupId] = await safeIKMQuery(
        `SELECT id FROM mst_hospital WHERE hospital_id = ? AND id != ?`,
        [hospital_id.trim(), id]
      );
      if (dupId.length > 0)
        return res.status(409).json({ message: "Hospital ID sudah digunakan" });
    }

    await safeIKMQuery(
      `UPDATE mst_hospital
       SET hospital_name=?, hospital_id=?, company_name=?, address=?,
           latitude=?, longitude=?, username=?, password=?, username_unit=?, password_unit=?, password_to_valet=?,
           billing_by_kg=?, allow_express=?, price_per_kg=?, express_price_per_kg=?, kg_agreement=?, updated_at=NOW()
       WHERE id=?`,
      [
        hospital_name.trim(),
        hospital_id?.trim() || null,
        company_name?.trim() || null,
        address?.trim() || null,
        parseCoord(latitude),
        parseCoord(longitude),
        username?.trim() || null,
        password || null,
        username_unit?.trim() || null,
        password_unit || null,
        password_to_valet || null,
        billing_by_kg ? 1 : 0,
        allow_express ? 1 : 0,
        pricePerKg,
        expressPricePerKg,
        kgAgreement,
        id,
      ]
    );

    const regulerChanged = !pricesEqual(oldPrice, pricePerKg);
    const expressChanged = !pricesEqual(oldExpressPrice, expressPricePerKg);
    if (regulerChanged || expressChanged) {
      const actor = await resolveActor(req);
      if (regulerChanged) await insertPriceLog(id, oldPrice, pricePerKg, actor, "REGULER");
      if (expressChanged) await insertPriceLog(id, oldExpressPrice, expressPricePerKg, actor, "EXPRESS");
    }

    if (Array.isArray(rooms)) {
      const gudangLinenCount = rooms.filter((r) =>
        typeof r === "object" && r !== null ? r.is_gudang_linen : false
      ).length;
      if (gudangLinenCount > 1) {
        return res.status(400).json({ message: "Hanya diperbolehkan maksimal 1 ruangan sebagai gudang linen" });
      }

      const [existingRows] = await safeIKMQuery(
        `SELECT id FROM mst_rooms_rs WHERE hospital_id = ?`,
        [id]
      );
      const existingIds = existingRows.map((r) => r.id);
      const keepIds = [];

      for (const room of rooms) {
        const isObj = typeof room === "object" && room !== null;
        const name = (isObj ? room.room_name : room)?.trim();
        if (!name) continue;

        const roomId = isObj ? room.id : null;
        const isGudangLinen = isObj ? (room.is_gudang_linen ? 1 : 0) : 0;
        const isSpecialUnit = isObj ? (room.is_special_unit ? 1 : 0) : 0;

        if (roomId && existingIds.includes(Number(roomId))) {
          await safeIKMQuery(
            `UPDATE mst_rooms_rs
             SET room_name = ?, is_gudang_linen = ?, is_special_unit = ?
             WHERE id = ?`,
            [name, isGudangLinen, isSpecialUnit, roomId]
          );
          keepIds.push(Number(roomId));
        } else {
          await safeIKMQuery(
            `INSERT INTO mst_rooms_rs (hospital_id, room_name, is_gudang_linen, is_special_unit)
             VALUES (?, ?, ?, ?)`,
            [id, name, isGudangLinen, isSpecialUnit]
          );
        }
      }

      const deleteIds = existingIds.filter((eid) => !keepIds.includes(eid));
      if (deleteIds.length > 0) {
        await safeIKMQuery(`DELETE FROM mst_rooms_rs WHERE id IN (?)`, [deleteIds]);
      }
    } else {
      await safeIKMQuery(`DELETE FROM mst_rooms_rs WHERE hospital_id = ?`, [id]);
    }

    res.json({ message: "Rumah sakit berhasil diperbarui" });
  } catch (err) {
    console.error("updateHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE ─────────────────────────────────────────────────────────────────
export const deleteHospital = async (req, res) => {
  const { id } = req.params;
  try {
    const [exist] = await safeIKMQuery(`SELECT id FROM mst_hospital WHERE id = ?`, [id]);
    if (exist.length === 0)
      return res.status(404).json({ message: "Rumah sakit tidak ditemukan" });

    await safeIKMQuery(`DELETE FROM mst_hospital WHERE id = ?`, [id]);
    res.json({ message: "Rumah sakit berhasil dihapus" });
  } catch (err) {
    console.error("deleteHospital:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── ROOM OPERATIONS ────────────────────────────────────────────────────────
export const createRoom = async (req, res) => {
  const { hospitalId } = req.params;
  const { room_name, is_gudang_linen, is_special_unit } = req.body;

  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }

  try {
    const isGudang = is_gudang_linen ? 1 : 0;
    const isSpecial = is_special_unit ? 1 : 0;
    if (isGudang) {
      const [existing] = await safeIKMQuery(
        `SELECT id FROM mst_rooms_rs WHERE hospital_id = ? AND is_gudang_linen = 1`,
        [hospitalId]
      );
      if (existing.length > 0) {
        return res.status(400).json({ message: "Rumah sakit ini sudah memiliki gudang linen" });
      }
    }

    const [result] = await safeIKMQuery(
      `INSERT INTO mst_rooms_rs (hospital_id, room_name, is_gudang_linen, is_special_unit) VALUES (?, ?, ?, ?)`,
      [hospitalId, room_name.trim(), isGudang, isSpecial]
    );
    res.status(201).json({
      message: "Ruangan berhasil ditambahkan",
      id: result.insertId,
      is_gudang_linen: isGudang,
      is_special_unit: isSpecial,
    });
  } catch (err) {
    console.error("createRoom:", err);
    res.status(500).json({ message: err.message });
  }
};

export const updateRoom = async (req, res) => {
  const { roomId } = req.params;
  const { room_name, is_gudang_linen, is_special_unit } = req.body;

  if (!room_name?.trim()) {
    return res.status(400).json({ message: "Nama ruangan wajib diisi" });
  }

  try {
    const isGudang = is_gudang_linen ? 1 : 0;
    const isSpecial = is_special_unit ? 1 : 0;
    if (isGudang) {
      const [roomInfo] = await safeIKMQuery(`SELECT hospital_id FROM mst_rooms_rs WHERE id = ?`, [roomId]);
      if (roomInfo.length > 0) {
        const [existing] = await safeIKMQuery(
          `SELECT id FROM mst_rooms_rs WHERE hospital_id = ? AND is_gudang_linen = 1 AND id != ?`,
          [roomInfo[0].hospital_id, roomId]
        );
        if (existing.length > 0) {
          return res.status(400).json({ message: "Rumah sakit ini sudah memiliki gudang linen" });
        }
      }
    }

    await safeIKMQuery(
      `UPDATE mst_rooms_rs SET room_name = ?, is_gudang_linen = ?, is_special_unit = ? WHERE id = ?`,
      [room_name.trim(), isGudang, isSpecial, roomId]
    );
    res.json({ message: "Nama ruangan berhasil diperbarui" });
  } catch (err) {
    console.error("updateRoom:", err);
    res.status(500).json({ message: err.message });
  }
};

export const deleteRoom = async (req, res) => {
  const { roomId } = req.params;

  try {
    await safeIKMQuery(`DELETE FROM mst_rooms_rs WHERE id = ?`, [roomId]);
    res.json({ message: "Ruangan berhasil dihapus" });
  } catch (err) {
    console.error("deleteRoom:", err);
    res.status(500).json({ message: err.message });
  }
};

// ── USER UNIT (mst_users_rs) ───────────────────────────────────────────────
// Login di linen-monitoring-system memeriksa beberapa tabel berurutan, jadi username tidak boleh
// sama dengan akun valet (users) atau akun umum RS/unit (mst_hospital).
async function usernameConflict(username) {
  const [valet] = await safeQuery(
    "SELECT 1 FROM users WHERE username = ? OR email = ? LIMIT 1", [username, username]);
  if (valet.length) return "Username sudah digunakan akun lain";
  const [hosp] = await safeIKMQuery(
    "SELECT 1 FROM mst_hospital WHERE username = ? OR username_unit = ? LIMIT 1", [username, username]);
  if (hosp.length) return "Username sudah digunakan akun lain";
  return null;
}

const readUnitUser = (b) => ({
  name: (b.nurse_name || "").trim(),
  phone: (b.phone || "").trim(),
  username: (b.username || "").trim(),
  password: (b.password || "").trim(),
  role: b.role === "rs" ? "rs" : "unit",
  roomIds: Array.isArray(b.room_ids) ? b.room_ids.map(Number).filter(Boolean) : [],
});

async function saveUnitUserRooms(userId, hospitalId, roomIds) {
  await safeIKMQuery(`DELETE FROM mst_users_rs_rooms WHERE user_id = ?`, [userId]);
  if (!roomIds.length) return;
  const [valid] = await safeIKMQuery(
    `SELECT id FROM mst_rooms_rs WHERE hospital_id = ? AND id IN (?)`,
    [hospitalId, roomIds]
  );
  if (valid.length) {
    await safeIKMQuery(`INSERT INTO mst_users_rs_rooms (user_id, room_id) VALUES ?`, [
      valid.map((r) => [userId, r.id]),
    ]);
  }
}

export const getUnitUsers = async (req, res) => {
  try {
    const { hospitalId } = req.params;
    const [users] = await safeIKMQuery(
      `SELECT id, nurse_name, phone, username, password, role, is_active
       FROM mst_users_rs WHERE hospital_id = ? ORDER BY nurse_name ASC`,
      [hospitalId]
    );
    const [links] = await safeIKMQuery(
      `SELECT ur.user_id, ur.room_id FROM mst_users_rs_rooms ur
       INNER JOIN mst_users_rs u ON u.id = ur.user_id WHERE u.hospital_id = ?`,
      [hospitalId]
    );
    res.json({
      success: true,
      data: users.map((u) => ({
        ...u,
        room_ids: links.filter((l) => l.user_id === u.id).map((l) => l.room_id),
      })),
    });
  } catch (err) {
    console.error("getUnitUsers:", err);
    res.status(500).json({ message: err.message });
  }
};

export const createUnitUser = async (req, res) => {
  const { hospitalId } = req.params;
  const { name, phone, username, password, role, roomIds } = readUnitUser(req.body);
  if (!name || !username || !password)
    return res.status(400).json({ message: "Nama, username, dan password wajib diisi" });
  try {
    const clash = await usernameConflict(username);
    if (clash) return res.status(409).json({ message: clash });
    const [r] = await safeIKMQuery(
      `INSERT INTO mst_users_rs (hospital_id, nurse_name, phone, username, password, role) VALUES (?, ?, ?, ?, ?, ?)`,
      [hospitalId, name, phone, username, password, role]
    );
    await saveUnitUserRooms(r.insertId, hospitalId, role === "rs" ? [] : roomIds);
    res.status(201).json({ message: "User unit berhasil ditambahkan", id: r.insertId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Username sudah digunakan" });
    console.error("createUnitUser:", err);
    res.status(500).json({ message: err.message });
  }
};

export const updateUnitUser = async (req, res) => {
  const { userId } = req.params;
  const { name, phone, username, password, role, roomIds } = readUnitUser(req.body);
  if (!name || !username || !password)
    return res.status(400).json({ message: "Nama, username, dan password wajib diisi" });
  try {
    const [exist] = await safeIKMQuery(`SELECT hospital_id, username FROM mst_users_rs WHERE id = ?`, [userId]);
    if (!exist.length) return res.status(404).json({ message: "User tidak ditemukan" });
    if (exist[0].username.toLowerCase() !== username.toLowerCase()) {
      const clash = await usernameConflict(username);
      if (clash) return res.status(409).json({ message: clash });
    }
    await safeIKMQuery(
      `UPDATE mst_users_rs SET nurse_name=?, phone=?, username=?, password=?, role=? WHERE id=?`,
      [name, phone, username, password, role, userId]
    );
    await saveUnitUserRooms(userId, exist[0].hospital_id, role === "rs" ? [] : roomIds);
    res.json({ message: "User unit berhasil diperbarui" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "Username sudah digunakan" });
    console.error("updateUnitUser:", err);
    res.status(500).json({ message: err.message });
  }
};

export const toggleUnitUser = async (req, res) => {
  try {
    const [r] = await safeIKMQuery(
      `UPDATE mst_users_rs SET is_active = IF(is_active=1,0,1) WHERE id = ?`,
      [req.params.userId]
    );
    if (!r.affectedRows) return res.status(404).json({ message: "User tidak ditemukan" });
    res.json({ message: "Status user diperbarui" });
  } catch (err) {
    console.error("toggleUnitUser:", err);
    res.status(500).json({ message: err.message });
  }
};

export const deleteUnitUser = async (req, res) => {
  try {
    const { userId } = req.params;
    await safeIKMQuery(`DELETE FROM mst_users_rs_rooms WHERE user_id = ?`, [userId]);
    await safeIKMQuery(`DELETE FROM mst_users_rs WHERE id = ?`, [userId]);
    res.json({ message: "User unit dihapus" });
  } catch (err) {
    console.error("deleteUnitUser:", err);
    res.status(500).json({ message: err.message });
  }
};
