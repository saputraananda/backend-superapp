import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG MAIN DB (waschen / waschen_prod)
// ═══════════════════════════════════════════════════════════════════════════
const MAIN_DB_CONFIG = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  idleTimeout: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG SMARTLINK DB (waschen_smartlink)
// ═══════════════════════════════════════════════════════════════════════════
const SMARTLINK_DB_CONFIG = {
  host: process.env.DB_HOST_SMARTLINK || process.env.DB_HOST,
  port: Number(process.env.DB_PORT_SMARTLINK || process.env.DB_PORT) || 3306,
  user: process.env.DB_USER_SMARTLINK || process.env.DB_USER,
  password: process.env.DB_PASS_SMARTLINK || process.env.DB_PASS,
  database: process.env.DB_NAME_SMARTLINK,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  idleTimeout: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG CLEANOX DB (cleanox_smartlink)
// ═══════════════════════════════════════════════════════════════════════════
const CLEANOX_DB_CONFIG = {
  host: process.env.DB_HOST_CLEANOX || process.env.DB_HOST,
  port: Number(process.env.DB_PORT_CLEANOX || process.env.DB_PORT) || 3306,
  user: process.env.DB_USER_CLEANOX || process.env.DB_USER,
  password: process.env.DB_PASS_CLEANOX || process.env.DB_PASS,
  database: process.env.DB_NAME_CLEANOX,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  idleTimeout: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG IKM DB (ikm)
// ═══════════════════════════════════════════════════════════════════════════
const IKM_DB_CONFIG = {
  host: process.env.DB_HOST_IKM || process.env.DB_HOST,
  port: Number(process.env.DB_PORT_IKM || process.env.DB_PORT) || 3306,
  user: process.env.DB_USER_IKM || process.env.DB_USER,
  password: process.env.DB_PASS_IKM || process.env.DB_PASS,
  database: process.env.DB_NAME_IKM,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  idleTimeout: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG BACKUP CLEANOX DB (cleanox_smartlink backup)
// ═══════════════════════════════════════════════════════════════════════════
const BACKUP_CLEANOX_DB_CONFIG = {
  host: process.env.DB_HOST_BACKUP_CLEANOX || process.env.DB_HOST_CLEANOX || process.env.DB_HOST,
  port: Number(process.env.DB_PORT_BACKUP_CLEANOX || process.env.DB_PORT_CLEANOX || process.env.DB_PORT) || 3306,
  user: process.env.DB_USER_BACKUP_CLEANOX || process.env.DB_USER_CLEANOX || process.env.DB_USER,
  password: process.env.DB_PASS_BACKUP_CLEANOX || process.env.DB_PASS_CLEANOX || process.env.DB_PASS,
  database: process.env.DB_NAME_BACKUP_CLEANOX || process.env.DB_NAME_CLEANOX,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
  connectTimeout: 10_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
  idleTimeout: 60_000,
};

let mainPool = mysql.createPool(MAIN_DB_CONFIG);
let smartlinkPool = mysql.createPool(SMARTLINK_DB_CONFIG);
let cleanoxPool = mysql.createPool(CLEANOX_DB_CONFIG);
let ikmPool = mysql.createPool(IKM_DB_CONFIG);
let backupCleanoxPool = mysql.createPool(BACKUP_CLEANOX_DB_CONFIG);

const RECONNECT_CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "PROTOCOL_CONNECTION_LOST",
  "POOL_CLOSED",
  "ER_SERVER_GONE_ERROR",
];

// ═══════════════════════════════════════════════════════════════════════════
// Helper untuk safe query dengan auto-reconnect
// ═══════════════════════════════════════════════════════════════════════════
async function runSafeQuery(getPoolFn, config, sql, params) {
  try {
    const pool = getPoolFn();
    return await pool.query(sql, params);
  } catch (err) {
    const shouldRetry =
      RECONNECT_CODES.includes(err.code) ||
      err.message?.toLowerCase().includes("pool closed") ||
      err.message?.toLowerCase().includes("etimedout");

    if (shouldRetry) {
      console.warn(`[DB] Koneksi terputus (${err.code ?? err.message}), reconnecting...`);
      const oldPool = getPoolFn();
      await oldPool.end().catch(() => {});
      
      // Recreate pool
      const newPool = mysql.createPool(config);
      
      // Update reference
      if (config === MAIN_DB_CONFIG) {
        mainPool = newPool;
      } else if (config === SMARTLINK_DB_CONFIG) {
        smartlinkPool = newPool;
      } else if (config === CLEANOX_DB_CONFIG) {
        cleanoxPool = newPool;
      } else if (config === BACKUP_CLEANOX_DB_CONFIG) {
        backupCleanoxPool = newPool;
      } else {
        ikmPool = newPool;
      }
      
      console.info("[DB] Pool baru berhasil dibuat, retry query...");
      return await newPool.query(sql, params);
    }

    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT: safeQuery untuk DB utama
// ═══════════════════════════════════════════════════════════════════════════
export function safeQuery(sql, params) {
  return runSafeQuery(() => mainPool, MAIN_DB_CONFIG, sql, params);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT: safeSmartlinkQuery untuk DB smartlink
// ═══════════════════════════════════════════════════════════════════════════
export function safeSmartlinkQuery(sql, params) {
  return runSafeQuery(() => smartlinkPool, SMARTLINK_DB_CONFIG, sql, params);
}

// EXPORT: safeCleanoxQuery untuk DB cleanox
// ═══════════════════════════════════════════════════════════════════════════
export function safeCleanoxQuery(sql, params) {
  return runSafeQuery(() => cleanoxPool, CLEANOX_DB_CONFIG, sql, params);
}

// EXPORT: safeIKMQuery untuk DB ikm
// ═══════════════════════════════════════════════════════════════════════════
export function safeIKMQuery(sql, params) {
  return runSafeQuery(() => ikmPool, IKM_DB_CONFIG, sql, params);
}

// EXPORT: safeBackupCleanoxQuery untuk DB backup cleanox
// ═══════════════════════════════════════════════════════════════════════════
export function safeBackupCleanoxQuery(sql, params) {
  return runSafeQuery(() => backupCleanoxPool, BACKUP_CLEANOX_DB_CONFIG, sql, params);
}

// ═══════════════════════════════════════════════════════════════════════════
// DB Ping untuk keep-alive (opsional)
// ═══════════════════════════════════════════════════════════════════════════
export function startDbPing(intervalMs = 30_000) {
  setInterval(async () => {
    try {
      await mainPool.query("SELECT 1");
      await smartlinkPool.query("SELECT 1");
      await cleanoxPool.query("SELECT 1");
      await ikmPool.query("SELECT 1");
      await backupCleanoxPool.query("SELECT 1");
    } catch (err) {
      console.warn("[DB Ping] Gagal:", err.code ?? err.message);
    }
  }, intervalMs);
  console.info(`[DB Ping] Aktif untuk main + smartlink + cleanox + ikm + backup_cleanox, interval ${intervalMs / 1000}s`);
}

export { mainPool as pool, mainPool, smartlinkPool, cleanoxPool, ikmPool, backupCleanoxPool };
export default mainPool;