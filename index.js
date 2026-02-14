import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import session from "express-session";
import MySQLStore from "express-mysql-session";
import pool from "./db/pool.js";
import authRoutes from "./routes/auth/authRoutes.js";
import appRoutes from "./routes/appRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import satisfactionRoutes from "./routes/satisfactionRoutes.js";

console.log("🚀 Starting AloraSuperApp API...");

// Load environment variables
dotenv.config({
  path: process.env.NODE_ENV === "production" ? ".env.prod" : ".env"
});

// Validate required environment variables
const requiredEnv = ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME', 'SESSION_SECRET'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnv);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

// Trust proxy for production (Hostinger)
app.set("trust proxy", 1);

// Middleware
app.use(express.json());
app.use(cookieParser());

// ===== CORS Configuration =====
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return cb(null, true);
    
    // Allow all if no origins specified (dev mode)
    if (allowedOrigins.length === 0) return cb(null, true);
    
    // Check if origin is allowed
    if (allowedOrigins.includes(origin)) return cb(null, true);
    
    // Reject
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// ===== SESSION with MySQL Store =====
const MySQLStoreSession = MySQLStore(session);
const sessionStore = new MySQLStoreSession({
  clearExpired: true,
  checkExpirationInterval: 900000, // 15 minutes
  expiration: 7200000, // 2 hours
  createDatabaseTable: true, // Auto create sessions table
  schema: {
    tableName: 'sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data'
    }
  }
}, pool);

// Handle session store errors
sessionStore.onReady = () => {
  console.log('✅ MySQL session store ready');
};

app.use(session({
  name: "alora.sid",
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true, // Reset expiration on every request
  cookie: {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 2,
  },
}));

// ===== Health Check Endpoint =====
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK",
    message: "API berjalan Normal",
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

// ===== API Routes =====
app.use("/auth", authRoutes);
app.use("/apps", appRoutes);
app.use("/employees", employeeRoutes);
app.use("/satisfaction", satisfactionRoutes);

// ===== 404 Handler =====
app.use((req, res) => {
  res.status(404).json({ 
    message: "Endpoint not found",
    path: req.path
  });
});

// ===== Global Error Handler =====
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  
  // CORS error
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ 
      message: 'Access forbidden from this origin' 
    });
  }

  // Session store error
  if (err.message && err.message.includes('session')) {
    return res.status(500).json({ 
      message: 'Session error occurred' 
    });
  }

  // Database error
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    return res.status(503).json({ 
      message: 'Database connection lost' 
    });
  }

  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    return res.status(500).json({ 
      message: 'Database access denied' 
    });
  }

  // Default error response
  res.status(err.status || 500).json({
    message: isProd ? 'Internal server error' : err.message,
    ...(isProd ? {} : { stack: err.stack })
  });
});

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🌐 CORS Origins: ${allowedOrigins.join(', ') || 'All'}`);
});

// ===== Graceful Shutdown =====
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});