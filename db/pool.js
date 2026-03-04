import mysql from "mysql2/promise";
import dotenv from "dotenv";
dotenv.config();

const DB_CONFIG = {
  host:               process.env.DB_HOST,
  port:               Number(process.env.DB_PORT) || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  dateStrings:      true, // Pastikan DATE/TIME dikembalikan sebagai string, bukan JS Date (agar tidak kena timezone shift)

  // ── Cegah ETIMEDOUT ──
  connectTimeout:          10_000,
  enableKeepAlive:         true,
  keepAliveInitialDelay:   10_000,

  // ── Cegah koneksi stale / pool closed ──
  idleTimeout:             60_000,
};

let pool = mysql.createPool(DB_CONFIG);

const RECONNECT_CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "PROTOCOL_CONNECTION_LOST",
  "POOL_CLOSED",
  "ER_SERVER_GONE_ERROR",
];

export async function safeQuery(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    const shouldRetry =
      RECONNECT_CODES.includes(err.code) ||
      err.message?.toLowerCase().includes("pool closed") ||
      err.message?.toLowerCase().includes("etimedout");

    if (shouldRetry) {
      console.warn(`[DB] Koneksi terputus (${err.code ?? err.message}), reconnecting...`);
      await pool.end().catch(() => {});
      pool = mysql.createPool(DB_CONFIG);
      console.info("[DB] Pool baru berhasil dibuat, retry query...");
      return await pool.query(sql, params);
    }

    throw err;
  }
}

export function startDbPing(intervalMs = 30_000) {
  setInterval(async () => {
    try {
      await pool.query("SELECT 1");
    } catch (err) {
      console.warn("[DB Ping] Gagal:", err.code ?? err.message);
    }
  }, intervalMs);
  console.info(`[DB Ping] Aktif, interval ${intervalMs / 1000}s`);
}

export { pool };
export default pool;