import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import session from "express-session";
import authRoutes from "./routes/auth/authRoutes.js";
import appRoutes from "./routes/appRoutes.js";
import employeeRoutes from "./routes/employeeRoutes.js";
import pool from "./db/pool.js";

dotenv.config();
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: "http://localhost:5173", credentials: true }));
app.use(session({
  name: "alora.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 1000 * 60 * 60 * 2,
  },
}));

app.get("/health", (req, res) => res.json({ message: "API berjalan Normal" }));

// init tabel (sekali untuk dev)
app.post("/database", async (req, res) => {
  try {
    // Tabel Users (untuk login)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'admin',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Tabel Manajemen Aplikasi
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_apps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        href VARCHAR(255) NOT NULL,
        min_role VARCHAR(50) NOT NULL DEFAULT 'employee',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Bank
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_bank (
        bank_id INT AUTO_INCREMENT PRIMARY KEY,
        bank_name VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Company
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_company (
        company_id INT AUTO_INCREMENT PRIMARY KEY,
        company_code VARCHAR(50) NOT NULL UNIQUE,
        company_name VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Department
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_department (
        department_id INT AUTO_INCREMENT PRIMARY KEY,
        department_name VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Employment Status
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_employment_status (
        employment_status_id INT AUTO_INCREMENT PRIMARY KEY,
        employment_status_name VARCHAR(100) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Education Level
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_education_level (
        education_level_id INT AUTO_INCREMENT PRIMARY KEY,
        education_level_name VARCHAR(100) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Job Level
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_job_level (
        job_level_id INT AUTO_INCREMENT PRIMARY KEY,
        job_level_name VARCHAR(100) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Position
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_position (
        position_id INT AUTO_INCREMENT PRIMARY KEY,
        position_name VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Religion
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_religion (
        religion_id INT AUTO_INCREMENT PRIMARY KEY,
        religion_name VARCHAR(100) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Master Employee (Tabel Utama Karyawan)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mst_employee (
        employee_id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT,
        join_year YEAR,
        join_seq INT,
        nik VARCHAR(50) UNIQUE,
        full_name VARCHAR(255) NOT NULL,
        gender ENUM('L', 'P'),
        birth_place VARCHAR(255),
        birth_date DATE,
        address TEXT,
        ktp_number VARCHAR(50),
        family_card_number VARCHAR(50),
        phone_number VARCHAR(50),
        email VARCHAR(255),
        job_level_id INT,
        position_id INT,
        department_id INT,
        join_date DATE,
        employment_status_id INT,
        contract_end_date DATE,
        education_level_id INT,
        school_name VARCHAR(255),
        religion_id INT,
        marital_status ENUM('Single', 'Married', 'Divorced', 'Widowed'),
        bpjs_health_number VARCHAR(50),
        bpjs_employment_number VARCHAR(50),
        npwp_number VARCHAR(50),
        bank_id INT,
        bank_account_number VARCHAR(50),
        emergency_contact VARCHAR(255),
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        exit_date DATE,
        exit_reason TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (company_id) REFERENCES mst_company(company_id),
        FOREIGN KEY (job_level_id) REFERENCES mst_job_level(job_level_id),
        FOREIGN KEY (position_id) REFERENCES mst_position(position_id),
        FOREIGN KEY (department_id) REFERENCES mst_department(department_id),
        FOREIGN KEY (employment_status_id) REFERENCES mst_employment_status(employment_status_id),
        FOREIGN KEY (education_level_id) REFERENCES mst_education_level(education_level_id),
        FOREIGN KEY (religion_id) REFERENCES mst_religion(religion_id),
        FOREIGN KEY (bank_id) REFERENCES mst_bank(bank_id)
      )
    `);

    // Insert default data untuk mst_apps
    await pool.query(`
      INSERT IGNORE INTO mst_apps (id, name, description, href, min_role, is_active, sort_order)
      VALUES
        (1, 'HR - Data Karyawan', 'Manajemen data karyawan lengkap', '/employees', 'hr', 1, 1),
        (2, 'Master Data', 'Kelola data master perusahaan', '/master', 'admin', 1, 2),
        (3, 'Dashboard', 'Dashboard monitoring perusahaan', '/dashboard', 'employee', 1, 0),
        (4, 'Absensi', 'Manajemen absensi karyawan', '/attendance', 'hr', 1, 3),
        (5, 'Payroll', 'Manajemen penggajian karyawan', '/payroll', 'admin', 1, 4),
        (6, 'Laporan', 'Laporan dan analitik', '/reports', 'manager', 1, 5)
    `);

    // Insert default data Master Bank (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_bank (bank_id, bank_name) VALUES
        (1, 'BCA'),
        (2, 'Mandiri'),
        (3, 'BNI'),
        (4, 'BRI'),
        (5, 'CIMB Niaga'),
        (6, 'Danamon'),
        (7, 'Permata Bank'),
        (8, 'Panin Bank'),
        (9, 'OCBC NISP'),
        (10, 'Bank Mega'),
        (11, 'BTN'),
        (12, 'BII (Maybank)'),
        (13, 'BTPN'),
        (14, 'Bank Syariah Indonesia (BSI)'),
        (15, 'Bank Jago'),
        (16, 'Bank Neo Commerce'),
        (17, 'Bank DBS Indonesia'),
        (18, 'Standard Chartered'),
        (19, 'Citibank'),
        (20, 'HSBC')
    `);

    // Insert default data Master Company (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_company (company_id, company_code, company_name) VALUES
        (1, 'WAI', 'PT Waschen Alora Indonesia'),
        (2, 'IKM', 'PT Intersolusi Karya Mandiri'),
        (3, 'CLX', 'Cleanox Indonesia')
    `);

    // Insert default data Master Department (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_department (department_id, department_name) VALUES
        (1, 'HR, GA, Legal & Secretary'),
        (2, 'Finance, Accountiing & Tax'),
        (3, 'Business Development, Sales & Marketing')
    `);

    // Insert default data Master Employment Status (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_employment_status (employment_status_id, employment_status_name) VALUES
        (1, 'PKWT - Kontrak 1 Tahun'),
        (2, 'PKWT - Kontrak 6 Bulan'),
        (3, 'PKWT - Kontrak 3 Bulan'),
        (4, 'PKWTT - Tetap'),
        (5, 'Probation - 3 Bulan'),
        (6, 'Probation - 6 Bulan'),
        (7, 'Magang'),
        (8, 'Freelance'),
        (9, 'Part Time'),
        (10, 'Outsourcing')
    `);

    // Insert default data Master Education Level (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_education_level (education_level_id, education_level_name) VALUES
        (1, 'SD'),
        (2, 'SMP'),
        (3, 'SMA'),
        (4, 'SMK'),
        (5, 'D1'),
        (6, 'D2'),
        (7, 'D3'),
        (8, 'D4'),
        (9, 'S1'),
        (10, 'S2'),
        (11, 'S3'),
        (12, 'Profesi')
    `);

    // Insert default data Master Job Level (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_job_level (job_level_id, job_level_name) VALUES
        (1, 'Staff'),
        (2, 'Junior Staff'),
        (3, 'Senior Staff'),
        (4, 'Supervisor'),
        (5, 'Assistant Manager'),
        (6, 'Manager'),
        (7, 'Senior Manager'),
        (8, 'General Manager'),
        (9, 'Vice President'),
        (10, 'Senior Vice President'),
        (11, 'Director'),
        (12, 'Vice Director'),
        (13, 'President Director'),
        (14, 'Commissioner'),
        (15, 'Admin')
    `);

    // Insert default data Master Position (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_position (position_id, position_name) VALUES
        (1, 'HR, GA, Legal & Secretary'),
        (2, 'General Affair'),
        (3, 'Business Development'),
        (4, 'Digital Marketing'),
        (5, 'Data Analyst')
    `);

    // Insert default data Master Religion (FULL)
    await pool.query(`
      INSERT IGNORE INTO mst_religion (religion_id, religion_name) VALUES
        (1, 'Islam'),
        (2, 'Kristen Protestan'),
        (3, 'Kristen Katolik'),
        (4, 'Hindu'),
        (5, 'Buddha'),
        (6, 'Konghucu'),
        (7, 'Lainnya')
    `);

    // Insert contoh karyawan: Ananda Prathama Saputra
    await pool.query(`
      INSERT IGNORE INTO mst_employee (
        employee_id,
        company_id,
        join_year,
        join_seq,
        nik,
        full_name,
        gender,
        birth_place,
        birth_date,
        address,
        ktp_number,
        family_card_number,
        phone_number,
        email,
        job_level_id,
        position_id,
        department_id,
        join_date,
        employment_status_id,
        contract_end_date,
        education_level_id,
        school_name,
        religion_id,
        marital_status,
        bpjs_health_number,
        bpjs_employment_number,
        npwp_number,
        bank_id,
        bank_account_number,
        emergency_contact,
        is_deleted,
        notes
      ) VALUES (
        1,
        1,
        2023,
        1,
        'WAI-2023-001',
        'Ananda Prathama Saputra',
        'L',
        'Jakarta',
        '1995-05-15',
        'Jl. Sudirman No. 123, Jakarta Selatan, DKI Jakarta 12190',
        '3173051505950001',
        '3173050101230001',
        '081234567890',
        'ananda.prathama@waschen.co.id',
        1,      -- job_level_id (ada)
        1,      -- position_id (ganti dari 13 ke 1, agar valid)
        1,      -- department_id (ada)
        '2023-01-15',
        4,      -- employment_status_id (ada)
        NULL,
        9,      -- education_level_id (ada)
        'Institut Pertanian Bogor',
        1,      -- religion_id (ada)
        'Married',
        '0001234567890',
        '12345678901',
        '12.345.678.9-012.000',
        1,      -- bank_id (ada)
        '1234567890',
        'Bapak Deny (082198765432)',
        0,
        'Karyawan berprestasi, telah menyelesaikan beberapa project besar'
      )
    `);

    res.json({ ok: true, message: "Database initialized successfully with full master data and sample employee" });
  } catch (error) {
    console.error("Database initialization error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Modular routes
app.use("/auth", authRoutes);
app.use("/apps", appRoutes);
app.use("/employees", employeeRoutes);

app.listen(process.env.PORT, () => console.log(`API http://localhost:${process.env.PORT}`));