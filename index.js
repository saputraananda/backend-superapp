// index.js (ESM)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import MySQLStore from "express-mysql-session";
import cron from "node-cron";

import { pool, startDbPing } from "./db/pool.js";

import authRoutes from "./routes/auth/authRoutes.js";
import appRoutes from "./routes/appRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import satisfactionRoutes from "./routes/satisfactionRoutes.js";
import pmRoutes from "./routes/pmRoutes.js";
import masterKarRoutes from "./routes/masterKarRoutes.js";
import dailyTaskRoutes from "./routes/dailyTaskRoutes.js";
import broadcastRoutes from "./routes/broadcastRoutes.js";
import masterUserRoutes from "./routes/masterDataSuperApp/masterUserRoutes.js";
import masterMenuRoutes from "./routes/masterDataSuperApp/masterMenuRoutes.js";
import masterBankRoutes from "./routes/masterDataSuperApp/masterBankRoutes.js";
import masterCompanyRoutes from "./routes/masterDataSuperApp/masterCompanyRoutes.js";
import masterDepartmentRoutes from "./routes/masterDataSuperApp/masterDepartmentRoutes.js";
import masterEducationLevelRoutes from "./routes/masterDataSuperApp/masterEducationLevelRoutes.js";
import masterEmployeeStatusRoutes from "./routes/masterDataSuperApp/masterEmployeeStatusRoutes.js";
import masterJobLevelRoutes from "./routes/masterDataSuperApp/masterJobLevelRoutes.js";
import masterOutletRoutes from "./routes/masterDataSuperApp/masterOutletRoutes.js";
import masterPositionRoutes from "./routes/masterDataSuperApp/masterPositionRoutes.js";
import masterReligionRoutes from "./routes/masterDataSuperApp/masterReligionRoutes.js";
import masterSatuanRoutes from "./routes/masterDataSuperApp/masterSatuanRoutes.js";
import masterVendorRoutes from "./routes/masterDataSuperApp/masterVendorRoutes.js";
import asetRoutes from "./routes/asetRoutes.js";
import targetWaschenRoutes from "./routes/targetWaschenRoutes.js";
import salesRoutes from "./routes/salesRoutes.js";
import personalTasklistRoutes from "./routes/personalTasklistRoutes.js";
import absensiIKMRoutes from "./routes/IKM/absensiIKMRoutes.js";
import employeeIKMRoutes from "./routes/IKM/employeeIKMRoutes.js";
import leavesIKMRoutes from "./routes/IKM/leavesIKMRoutes.js";
import masterAbsensiRoutes from "./routes/IKM/masterAbsensiRoutes.js";
import masterRsIkmRoutes from "./routes/IKM/masterRsIkmRoutes.js";
import linenReportRoutes from "./routes/IKM/linenReportRoutes.js";
import masterLinenIKMRoutes from "./routes/IKM/masterLinenIKMRoutes.js";
import masterDataIKMRoutes from "./routes/IKM/masterDataIKMRoutes.js";
import hospitalLinenRoutes from "./routes/IKM/hospitalLinenRoutes.js";
import masterRoomsIKMRoutes from "./routes/IKM/masterRoomsIKMRoutes.js";
import rewashLinenRoutes from "./routes/IKM/rewashLinenRoutes.js";
import leaderDailyReportRoutes from "./routes/IKM/leaderDailyReportRoutes.js";
import kasbonRoutes from "./routes/IKM/kasbonRoutes.js";
import absensiManajemenIKMRoutes from "./routes/IKM/absensiManajemenIKMRoutes.js";
import stockOpnameIKMRoutes from "./routes/IKM/stockOpnameIKMRoutes.js";
import linenTransactionRoutes from "./routes/IKM/linenTransactionRoutes.js";
import linenTransactionKomersilRoutes from "./routes/IKM/linenTransactionKomersilRoutes.js";
import operationalRoutes from "./routes/operationalRoutes.js";
import internalRoutes from "./routes/internalRoutes.js";
import complaintRoutes from "./routes/complaintRoutes.js";
import pengajuanRoutes from "./routes/pengajuanRoutes.js";
import docAloraRoutes from "./routes/docAloraRoutes.js";
import csatNpsRoutes from "./routes/csatNpsRoutes.js";
import b2bKoperasiRoutes from "./routes/B2B/B2B-Koperasi-2026/b2bKoperasiDashboardRoutes.js";
import b2bKoperasiCustomerRoutes from "./routes/B2B/B2B-Koperasi-2026/b2bKoperasiCustomerRoutes.js";
import employeeMoodRoutes from "./routes/employeeMoodRoutes.js";
import knowYourEmpRoutes from "./routes/knowYourEmpRoutes.js";
import analysisBurnoutRoutes from "./routes/analysisBurnoutRoutes.js";
import employeeCleanoxRoutes from "./routes/Cleanox/employeeCleanoxRoutes.js";
import absensiKaryawanCleanoxRoutes from "./routes/Cleanox/absensiKaryawanCleanoxRoutes.js";
import leavesCleanoxRoutes from "./routes/Cleanox/leavesCleanoxRoutes.js";
import leavesAloraRoutes from "./routes/Alora/leavesAloraRoutes.js";
import kasbonCleanoxRoutes from "./routes/Cleanox/kasbonCleanoxRoutes.js";
import masterAreaKebersihanCleanoxRoutes from "./routes/Cleanox/masterAreaKebersihanCleanoxRoutes.js";
import kpiProduksiRoutes from "./routes/Cleanox/kpiProduksiRoutes.js";
import masterServicesRoutes from "./routes/Cleanox/masterServicesRoutes.js";
import masterCategoryRoutes from "./routes/Cleanox/masterCategoryRoutes.js";
import targetCleanoxRoutes from "./routes/Cleanox/targetCleanoxRoutes.js";
import employeeWaschenRoutes from "./routes/MyWaschen/employeeWaschenRoutes.js";
import categoryServicesRoutes from "./routes/MyWaschen/MasterData/CategoryServicesRoutes.js";
import servicesWaschenRoutes from "./routes/MyWaschen/MasterData/ServicesRoutes.js";
import serviceSpeedRoutes from "./routes/MyWaschen/MasterData/ServiceSpeedRoutes.js";
import parfumeRoutes from "./routes/MyWaschen/MasterData/ParfumeRoutes.js";
import membershipPackageRoutes from "./routes/MyWaschen/MasterData/MembershipPackageRoutes.js";
import unitRoutes from "./routes/MyWaschen/MasterData/UnitRoutes.js";
import customerRoutes from "./routes/MyWaschen/MasterData/CustomerRoutes.js";
import customerTierRoutes from "./routes/MyWaschen/MasterData/CustomerTierRoutes.js";
import customerSourceRoutes from "./routes/MyWaschen/MasterData/CustomerSourceRoutes.js";
import paymentMethodRoutes from "./routes/MyWaschen/MasterData/PaymentMethodRoutes.js";
import pettyCashCategoryRoutes from "./routes/MyWaschen/MasterData/PettyCashCategoryRoutes.js";
import promoRoutes from "./routes/MyWaschen/MasterData/PromoRoutes.js";
import statusWorkRoutes from "./routes/MyWaschen/MasterData/StatusWorkRoutes.js";
import trainingRoutes from "./routes/trainingRoutes.js";
import projectManagementRoutes from "./routes/ProjectManagement/projectManagementRoutes.js";
import personalChatRoutes from "./routes/ProjectManagement/personalChatRoutes.js";


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
} else {
  // 2) Fallback: load default .env jika ada, atau rely on Hostinger panel env
  dotenv.config();
}



// =========================
// Validate required env
// =========================
const requiredEnv = ["DB_HOST", "DB_USER", "DB_PASS", "DB_NAME", "SESSION_SECRET"];
const missingEnv = requiredEnv.filter(
  (key) => !process.env[key] || String(process.env[key]).trim() === ""
);

if (missingEnv.length > 0) {
  console.error("Missing required environment variables:", missingEnv);
  console.error("Tips:");
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

// Skip body-parser untuk multipart (biarkan multer handle)
app.use((req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return next();
  }
  express.json({ limit: "2mb" })(req, res, () => {
    express.urlencoded({ extended: true })(req, res, next);
  });
});

app.use(cookieParser());

// =========================
// CORS (stabil + preflight)
// =========================
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, cb) {
    // Allow requests with no origin (Postman, mobile apps, server-to-server)
    if (!origin) return cb(null, true);

    // Allow all if not specified (dev)
    if (allowedOrigins.length === 0) return cb(null, true);

    if (allowedOrigins.includes(origin)) return cb(null, true);

    console.error("[CORS] Blocked request from origin:", origin);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// =========================
// Session store (MySQL)
// =========================
const MySQLStoreSession = MySQLStore(session);

const sessionStore = new MySQLStoreSession(
  {
    clearExpired: true,
    checkExpirationInterval: 900000, // 15 min
    expiration: 7200000, // 2 hours
    // Lebih aman: jangan auto create table di production
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

sessionStore.on("error", (err) => {
  console.error("[SessionStore] Error (server tetap jalan):", err?.code ?? err?.message ?? err);
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
// Static assets (DEV vs PROD)
// =========================
const STATIC_DEV_BASE = path.join(__dirname, "assets");
const STATIC_PROD_BASE = process.env.UPLOAD_BASE_DIR || "/home/u420573163/domains/api.waschenalora.com/storage/assets/";
const ASSETS_BASE = isProd ? STATIC_PROD_BASE : STATIC_DEV_BASE; // ← define dulu

app.use("/assets/evidence", express.static(path.join(ASSETS_BASE, "evidence")));
app.use("/assets/avatars", express.static(path.join(ASSETS_BASE, "avatars")));
app.use("/assets/documents", express.static(path.join(ASSETS_BASE, "documents")));
app.use("/assets/daily_evidence", express.static(path.join(ASSETS_BASE, "daily_evidence")));
app.use("/assets", express.static(ASSETS_BASE));
app.use("/assets/aset_photos", express.static(path.join(ASSETS_BASE, "aset_photos")));
app.use("/assets/tasklist_evidence", express.static(path.join(ASSETS_BASE, "tasklist_evidence")));
app.use("/assets/buktiLO", express.static(path.join(ASSETS_BASE, "buktiLO")));
app.use("/assets/butkiLO", express.static(path.join(ASSETS_BASE, "butkiLO")));
app.use("/assets/ikm_linen", express.static(path.join(ASSETS_BASE, "ikm_linen")));
app.use("/assets/ikm_briefing", express.static(path.join(ASSETS_BASE, "ikm_briefing")));
app.use("/assets/complaint_docs", express.static(path.join(ASSETS_BASE, "complaint_docs")));
app.use("/assets/kasbon", express.static(path.join(ASSETS_BASE, "kasbon")));
app.use("/assets/purchase", express.static(path.join(ASSETS_BASE, "purchase")));
app.use("/assets/document_alora", express.static(path.join(ASSETS_BASE, "document_alora")));
app.use("/assets/training_evidence", express.static(path.join(ASSETS_BASE, "training_evidence")));
app.use("/assets/pm_evidence", express.static(path.join(ASSETS_BASE, "pm_evidence")));
app.use("/storage/assets/payslip", express.static(path.join(ASSETS_BASE, "payslip")));



// =========================
// Routes
// =========================
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "API berjalan normal",
    environment: process.env.NODE_ENV ?? "undefined",
    UPLOAD_BASE_DIR: process.env.UPLOAD_BASE_DIR,
    timestamp: new Date().toISOString(),
  });
});

app.get("/debug-file-exists", (req, res) => {
  const rel = req.query.p;
  if (!rel) return res.status(400).json({ error: "missing ?p=" });

  const full = path.join(ASSETS_BASE, rel);
  res.json({
    ASSETS_BASE,
    fullPath: full,
    exists: fs.existsSync(full),
  });
});


app.use("/auth", authRoutes);
app.use("/apps", appRoutes);
app.use("/employees", employeeRoutes);
app.use("/satisfaction", satisfactionRoutes);
app.use("/api/pm", pmRoutes);
app.use("/hr", masterKarRoutes);
app.use("/daily-tasks", dailyTaskRoutes);
app.use("/broadcast", broadcastRoutes);
app.use("/users", masterUserRoutes);
app.use("/menus", masterMenuRoutes);
app.use("/banks", masterBankRoutes);
app.use("/companies", masterCompanyRoutes);
app.use("/departments", masterDepartmentRoutes);
app.use("/education-levels", masterEducationLevelRoutes);
app.use("/employment-statuses", masterEmployeeStatusRoutes);
app.use("/job-levels", masterJobLevelRoutes);
app.use("/outlets", masterOutletRoutes);
app.use("/positions", masterPositionRoutes);
app.use("/religions", masterReligionRoutes);
app.use("/satuan", masterSatuanRoutes);
app.use("/vendors", masterVendorRoutes);
app.use("/aset", asetRoutes);
app.use("/target-waschen", targetWaschenRoutes);
app.use("/sales", salesRoutes);
app.use("/personal-tasklist", personalTasklistRoutes);
app.use("/ikm/absensi", absensiIKMRoutes);
app.use("/ikm/employees", employeeIKMRoutes);
app.use("/ikm/leaves", leavesIKMRoutes);
app.use("/alora/leaves", leavesAloraRoutes);
app.use("/ikm/master-absensi", masterAbsensiRoutes);
app.use("/ikm/master-rs", masterRsIkmRoutes);
app.use("/ikm/linen-report", linenReportRoutes);
app.use("/ikm/master-linen", masterLinenIKMRoutes);
app.use("/ikm/hospital-linen", hospitalLinenRoutes);
app.use("/ikm/master-rooms", masterRoomsIKMRoutes);
app.use("/ikm/rewash-linen", rewashLinenRoutes);
app.use("/ikm/master-data", masterDataIKMRoutes);
app.use("/ikm/leader-daily-report", leaderDailyReportRoutes);
app.use("/ikm/kasbon", kasbonRoutes);
app.use("/ikm/absensi-manajemen", absensiManajemenIKMRoutes);
app.use("/ikm/stock-opname", stockOpnameIKMRoutes);
app.use("/ikm/linen-transactions", linenTransactionRoutes);
app.use("/ikm/linen-transactions-komersil", linenTransactionKomersilRoutes);
app.use("/operational", operationalRoutes);
app.use("/internal", internalRoutes);
app.use("/complaints", complaintRoutes);
app.use("/pengajuan", pengajuanRoutes);
app.use("/doc-alora", docAloraRoutes);
app.use("/csat-nps", csatNpsRoutes);
app.use("/b2b", b2bKoperasiRoutes);
app.use("/b2b", b2bKoperasiCustomerRoutes);
app.use("/api/employee-mood", employeeMoodRoutes);
app.use("/know-your-employee", knowYourEmpRoutes);
app.use("/analysis-burnout", analysisBurnoutRoutes);
app.use("/cleanox/employees", employeeCleanoxRoutes);
app.use("/cleanox/attendance", absensiKaryawanCleanoxRoutes);
app.use("/cleanox/leaves", leavesCleanoxRoutes);
app.use("/cleanox/kasbon", kasbonCleanoxRoutes);
app.use("/cleanox/kebersihan", masterAreaKebersihanCleanoxRoutes);
app.use("/kpi", kpiProduksiRoutes);
app.use("/master-services", masterServicesRoutes);
app.use("/master-categories", masterCategoryRoutes);
app.use("/target-cleanox", targetCleanoxRoutes);
app.use("/waschen/employees", employeeWaschenRoutes);
app.use("/waschen/category-services", categoryServicesRoutes);
app.use("/waschen/services", servicesWaschenRoutes);
app.use("/waschen/service-speeds", serviceSpeedRoutes);
app.use("/waschen/parfumes", parfumeRoutes);
app.use("/waschen/membership-packages", membershipPackageRoutes);
app.use("/waschen/units", unitRoutes);
app.use("/waschen/customers", customerRoutes);
app.use("/waschen/customer-tiers", customerTierRoutes);
app.use("/waschen/customer-sources", customerSourceRoutes);
app.use("/waschen/payment-methods", paymentMethodRoutes);
app.use("/waschen/petty-cash-categories", pettyCashCategoryRoutes);
app.use("/waschen/promos", promoRoutes);
app.use("/waschen/work-statuses", statusWorkRoutes);
app.use("/training", trainingRoutes);
app.use("/api/pm2", projectManagementRoutes);
app.use("/api/pm2/chat", personalChatRoutes);
// 404
app.use((req, res) => {
  res.status(404).json({ message: "Endpoint not found", path: req.path });
});

// =========================
// Global error handler
// =========================
app.use((err, req, res, next) => {
  console.error("Error:", err);

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
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ AloraSuperApp API running on port ${PORT} [${process.env.NODE_ENV ?? "development"}]`);

  // Ping DB setiap 30 detik
  startDbPing(30_000);

  // ─── Daily blast 15:30 WIB (UTC+7 = 08:30 UTC) ───────────────
  // cron.schedule("30 8 * * *", async () => {
  //   console.log("[CRON] Menjalankan blast progress task pukul 15:30...");
  //   await sendWaDailyProgressBlast();
  // }, { timezone: "Asia/Jakarta" });

  // console.log("⏰ Cron: blast WA harian terjadwal pukul 15:30 WIB");
});

// =========================
// Graceful shutdown
// =========================
async function shutdown(signal) {
  try {
    await pool.end();
  } catch (e) {
    console.error(`[Shutdown] Error closing DB pool (${signal}):`, e?.message ?? e);
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

