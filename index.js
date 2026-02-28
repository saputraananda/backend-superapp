// server.js (ESM)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import MySQLStore from "express-mysql-session";

import { pool, startDbPing } from "./db/pool.js";

import authRoutes from "./routes/auth/authRoutes.js";
import appRoutes from "./routes/appRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import satisfactionRoutes from "./routes/satisfactionRoutes.js";
import pmRoutes from "./routes/pmRoutes.js";
import masterKarRoutes from "./routes/masterKarRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// Env loading (SAFE)
// =========================
const isProd = process.env.NODE_ENV === "production";

// 1) Coba load file .env / .env.prod kalau ada
const envFile = isProd ? ".env.prod" : ".env";
if (fs.existsSync(path.join(process.cwd(), envFile))) {
  dotenv.config({ path: envFile });
  console.log(`✅ Loaded env file: ${envFile}`);
} else {
  // 2) Fallback: load default .env jika ada, atau rely on Hostinger panel env
  dotenv.config();
  console.log(`ℹ️ Env file ${envFile} not found. Using default dotenv (if any) + process env from panel.`);
}

console.log("🚀 Starting AloraSuperApp API...");

// =========================
// Validate required env
// =========================
const requiredEnv = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME", "SESSION_SECRET"];
const missingEnv = requiredEnv.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");

if (missingEnv.length > 0) {
  console.error("❌ Missing required environment variables:", missingEnv);
  console.error("➡️ Tips:");
  console.error("   - If on Hostinger: set them in hPanel -> Node.js -> Environment variables");
  console.error("   - Or ensure .env/.env.prod exists in your project root");
  process.exit(1);
}

// =========================
// App init
// =========================
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// =========================
// CORS
// =========================
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, cb) {
      // Allow requests with no origin (Postman, mobile apps, server-to-server)
      if (!origin) return cb(null, true);

      // Allow all if not specified (dev)
      if (allowedOrigins.length === 0) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// =========================
// Session store (MySQL)
// =========================
const MySQLStoreSession = MySQLStore(session);

const sessionStore = new MySQLStoreSession(
  {
    clearExpired: true,
    checkExpirationInterval: 900000, // 15 min
    expiration: 7200000, // 2 hours
    // Lebih aman: jangan auto create table di production (sering bikin masalah permission/hang)
    createDatabaseTable: isProd ? false : true,
    schema: {
      tableName: "sessions",
      columnNames: {
        session_id: "session_id",
        expires: "expires",
        data: "data",
      },
    },
  },
  pool
);

// Event handler yang valid
sessionStore.on("error", (err) => {
  console.error("[SessionStore] Error (server tetap jalan):", err?.code ?? err?.message ?? err);
});

sessionStore.on("connect", () => {
  // Tidak semua versi emit "connect", tapi aman kalau ada
  console.log("✅ MySQL session store connected");
});

// Session middleware
app.use(
  session({
    name: "alora.sid",
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd, // butuh HTTPS
      maxAge: 1000 * 60 * 60 * 2,
    },
  })
);

// =========================
// Routes
// =========================
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "API berjalan normal",
    environment: process.env.NODE_ENV ?? "undefined",
    timestamp: new Date().toISOString(),
  });
});

app.use("/auth", authRoutes);
app.use("/apps", appRoutes);
app.use("/employees", employeeRoutes);
app.use("/satisfaction", satisfactionRoutes);
app.use("/api/pm", pmRoutes);
app.use("/hr", masterKarRoutes);

// Static assets
app.use("/assets/evidence", express.static(path.join(__dirname, "assets", "evidence")));
app.use("/assets/avatars", express.static(path.join(__dirname, "assets", "avatars")));
app.use("/assets/documents", express.static(path.join(__dirname, "assets", "documents")));
app.use("/assets", express.static(path.join(__dirname, "assets")));

// 404
app.use((req, res) => {
  res.status(404).json({
    message: "Endpoint not found",
    path: req.path,
  });
});

// =========================
// Global error handler
// =========================
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);

  if (err?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Access forbidden from this origin" });
  }

  if (err?.code === "PROTOCOL_CONNECTION_LOST") {
    return res.status(503).json({ message: "Database connection lost" });
  }

  if (err?.code === "ER_ACCESS_DENIED_ERROR") {
    return res.status(500).json({ message: "Database access denied" });
  }

  return res.status(err?.status || 500).json({
    message: isProd ? "Internal server error" : err?.message || "Unknown error",
    ...(isProd ? {} : { stack: err?.stack }),
  });
});

// =========================
// Start server
// =========================
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 CORS Origins: ${allowedOrigins.join(", ") || "All"}`);

  // Ping DB setiap 30 detik (sesuai punyamu)
  startDbPing(30_000);
});

// =========================
// Graceful shutdown
// =========================
async function shutdown(signal) {
  try {
    console.log(`${signal} received: closing resources...`);
    await pool.end();
    console.log("✅ Database pool closed");
  } catch (e) {
    console.error("❌ Error during shutdown:", e);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));