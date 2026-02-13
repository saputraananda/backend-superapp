import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import session from "express-session";
import authRoutes from "./routes/auth/authRoutes.js";
import appRoutes from "./routes/appRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";

console.log("🚀 Starting AloraSuperApp API..."); // Tambahkan log di awal

dotenv.config({
  path: process.env.NODE_ENV === "production" ? ".env.prod" : ".env"
});
const app = express();

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

app.set("trust proxy", 1);

app.use(express.json());
app.use(cookieParser());

// ===== CORS =====
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true
}));

// ===== SESSION =====
app.use(session({
  name: "alora.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 1000 * 60 * 60 * 2,
  },
}));

app.get("/health", (req, res) => res.json({ message: "API berjalan Normal" }));

app.use("/auth", authRoutes);
app.use("/apps", appRoutes);
app.use("/employees", employeeRoutes);

app.listen(PORT, () => console.log(`API running on port ${PORT}`));