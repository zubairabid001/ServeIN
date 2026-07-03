require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const dns = require('dns');
const util = require('util');
const resolveMx = util.promisify(dns.resolveMx);

const app = express();
app.use(express.json());
app.use(cors());

// Configure Multer Storage
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
    filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage: storage });

// In-memory store for OTPs
const otpStore = new Map(); // stores email -> { otp, expiresAt }

// Serve static HTML files from the current directory
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadDir));
const DB_PORT = process.env.DB_PORT || 3306;
const PORT = process.env.PORT || 3000;
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'servein_db';
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret';

let pool;

async function initDB() {
    try {
        // 1. Connect without database to create it if it doesn't exist
       const connection = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD
});

        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;`);
        await connection.end();

        // 2. Connect to the actual database using a pool
        pool = mysql.createPool({
                 host: DB_HOST,
               port: DB_PORT,
              user: DB_USER,
               password: DB_PASSWORD,
               database: DB_NAME,
              waitForConnections: true,
             connectionLimit: 10,
                 queueLimit: 0
});
        // 3. Create Users table if it doesn't exist
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS users (
                id VARCHAR(50) PRIMARY KEY,
                full_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                cnic VARCHAR(20) NOT NULL,
                email VARCHAR(100) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `;
        await pool.query(createTableQuery);

        // Alter users table to add role and rating if they don't exist
        try {
            await pool.query("ALTER TABLE users ADD COLUMN role ENUM('customer', 'provider') DEFAULT 'customer', ADD COLUMN rating FLOAT DEFAULT 0.0, ADD COLUMN total_ratings INT DEFAULT 0;");
        } catch (e) {
            // Ignore error if columns already exist
        }

        // Alter users table to add profile picture
        try {
            await pool.query("ALTER TABLE users ADD COLUMN profile_pic VARCHAR(255) DEFAULT NULL;");
        } catch (e) {
            // Ignore if column already exists
        }

        // Create service_offers table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS service_offers (
                id INT AUTO_INCREMENT PRIMARY KEY,
                provider_id VARCHAR(50) NOT NULL,
                service_name VARCHAR(100) NOT NULL,
                hourly_rate DECIMAL(10, 2) NOT NULL,
                is_active BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Alter service_offers table to default is_active to FALSE
        try {
            await pool.query("ALTER TABLE service_offers MODIFY COLUMN is_active BOOLEAN DEFAULT FALSE;");
        } catch (e) {
            // Ignore error if already modified
        }

        // Create bookings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id INT AUTO_INCREMENT PRIMARY KEY,
                customer_id VARCHAR(50) NOT NULL,
                provider_id VARCHAR(50) NOT NULL,
                service_offer_id INT NOT NULL,
                hours_requested INT NOT NULL,
                location VARCHAR(255) NOT NULL,
                status ENUM('pending', 'accepted', 'rejected', 'completed', 'cancelled') DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (service_offer_id) REFERENCES service_offers(id) ON DELETE CASCADE
            )
        `);

        // Alter bookings table to add provider_done and customer_done columns if they don't exist
        try {
            await pool.query("ALTER TABLE bookings ADD COLUMN provider_done BOOLEAN DEFAULT FALSE, ADD COLUMN customer_done BOOLEAN DEFAULT FALSE;");
        } catch (e) {
            // Ignore error if columns already exist
        }

        // Create messages table (for chat)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                booking_id INT NOT NULL,
                sender_id VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create reviews table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reviews (
                id INT AUTO_INCREMENT PRIMARY KEY,
                booking_id INT NOT NULL UNIQUE,
                customer_id VARCHAR(50) NOT NULL,
                provider_id VARCHAR(50) NOT NULL,
                rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
                FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (provider_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Create notifications table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id VARCHAR(50) NOT NULL,
                type VARCHAR(50) NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        console.log(`✅ Connected to MySQL database '${DB_NAME}' and verified tables.`);
    } catch (error) {
        console.error('❌ Database Initialization Error:', error.message);
    }
}

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // { id, email }
        next();
    } catch (error) {
        res.status(403).json({ error: 'Invalid or expired token.' });
    }
};

// Helper: create a notification for a user
async function createNotification(userId, type, message) {
    try {
        await pool.query(
            'INSERT INTO notifications (user_id, type, message) VALUES (?, ?, ?)',
            [userId, type, message]
        );
    } catch (err) {
        console.error('Create Notification Error:', err.message);
    }
}

// --- API ROUTES ---

// CHECK EMAIL API (Real-time validation)
app.post('/api/check-email', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required.' });

        // 1. Check if email already exists in DB
        const [existingUsers] = await pool.query('SELECT email FROM users WHERE email = ?', [email]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ error: 'Email already registered. Please login instead.', field: 'email' });
        }

        // 2. Optionally check domain MX records - but treat DNS failures as valid (not as an error)
        const domain = email.split('@')[1];
        const wellKnownDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'live.com', 'protonmail.com', 'mail.com'];
        if (domain && !wellKnownDomains.includes(domain.toLowerCase())) {
            try {
                const mxRecords = await resolveMx(domain);
                if (!mxRecords || mxRecords.length === 0) {
                    return res.status(400).json({ error: 'Email domain appears invalid (no mail server found).', field: 'email' });
                }
            } catch (err) {
                // DNS lookup failed - treat as valid to avoid false negatives
                // (network issues should not block registration)
            }
        }

        res.json({ message: 'Email is valid and available.' });
    } catch (error) {
        console.error('Check Email Error:', error);
        res.status(500).json({ error: 'Failed to check email.' });
    }
});

// SEND OTP API
app.post('/api/send-otp', async (req, res) => {
    try {
        let { email, phone, cnic } = req.body;

        const rawPhone = phone || '';
        let normalizedPhoneStr = rawPhone.replace(/\D/g, '');
        if (normalizedPhoneStr.startsWith('0')) normalizedPhoneStr = normalizedPhoneStr.substring(1);
        const phoneWithZero = '0' + normalizedPhoneStr;

        // Ensure phone starts with 0 for uniqueness consistency
        if (phone && phone.startsWith('3')) {
            phone = '0' + phone;
        }

        // Check if email, phone, or cnic already exists
        const [existingUsers] = await pool.query(
            "SELECT email, phone, cnic FROM users WHERE email = ? OR REPLACE(phone, '-', '') IN (?, ?) OR cnic = ?",
            [email, normalizedPhoneStr, phoneWithZero, cnic]
        );
        if (existingUsers.length > 0) {
            for (let user of existingUsers) {
                if (user.email === email) return res.status(400).json({ error: 'Email already exists in our system.', field: 'email' });

                const dbPhoneNorm = user.phone ? user.phone.replace(/\D/g, '') : '';
                if (dbPhoneNorm === normalizedPhoneStr || dbPhoneNorm === phoneWithZero) {
                    return res.status(400).json({ error: 'Phone number already exists.', field: 'phone' });
                }

                if (user.cnic === cnic) return res.status(400).json({ error: 'CNIC already exists.', field: 'cnic' });
            }
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 }); // 10 minutes expiry

        // Attempt to send email
        let nodemailer;
        try {
            nodemailer = require('nodemailer');
        } catch (e) {
            // nodemailer not installed
        }

        if (nodemailer && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                console.log("EMAIL_USER =", process.env.EMAIL_USER);
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: {
                        user: process.env.EMAIL_USER,
                        pass: process.env.EMAIL_PASS
                    }
                });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: email,
                    subject: 'ServeIN - Your Verification OTP',
                    text: `Your OTP for ServeIN registration is: ${otp}. It is valid for 10 minutes.`
                });
                console.log(`✅ Actual OTP sent to ${email}`);
            } catch (mailError) {
                console.error('❌ Mail Sending Failed:', mailError.message);
                console.log(`[FALLBACK] Mock OTP for ${email} is ${otp}`);
                return res.status(400).json({ error: 'Email address not found or delivery failed. Please enter a valid email.', field: 'email' });
            }
        } else {
            console.log(`[MOCK EMAIL] OTP for ${email} is ${otp} (Set EMAIL_USER and EMAIL_PASS in .env for real emails)`);
        }
        res.json({ message: 'OTP sent successfully.' });
    } catch (error) {
        console.error('Send OTP Error:', error);
        res.status(400).json({ error: 'Failed to process OTP request.' });
    }
});

// REGISTER API
app.post('/api/register', async (req, res) => {
    try {
        let { fullName, phone, cnic, email, password, role, otp } = req.body;
        // All accounts are created as Customer by default
        const userRole = 'customer';

        const rawPhone = phone || '';
        let normalizedPhoneStr = rawPhone.replace(/\D/g, '');
        if (normalizedPhoneStr.startsWith('0')) normalizedPhoneStr = normalizedPhoneStr.substring(1);
        const phoneWithZero = '0' + normalizedPhoneStr;

        // Ensure phone starts with 0 for uniqueness consistency
        if (phone && phone.startsWith('3')) {
            phone = '0' + phone;
        }

        // Verify OTP
        const storedOtpData = otpStore.get(email);
        if (!storedOtpData || storedOtpData.otp !== otp || storedOtpData.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'Invalid or expired OTP.' });
        }

        // Check if email, phone, or cnic already exists
        const [existingUsers] = await pool.query(
            "SELECT email, phone, cnic FROM users WHERE email = ? OR REPLACE(phone, '-', '') IN (?, ?) OR cnic = ?",
            [email, normalizedPhoneStr, phoneWithZero, cnic]
        );
        if (existingUsers.length > 0) {
            for (let user of existingUsers) {
                if (user.email === email) return res.status(400).json({ error: 'Email already exists in our system.', field: 'email' });

                const dbPhoneNorm = user.phone ? user.phone.replace(/\D/g, '') : '';
                if (dbPhoneNorm === normalizedPhoneStr || dbPhoneNorm === phoneWithZero) {
                    return res.status(400).json({ error: 'Phone number already exists.', field: 'phone' });
                }

                if (user.cnic === cnic) return res.status(400).json({ error: 'CNIC already exists.', field: 'cnic' });
            }
        }

        // Generate a random system user ID (e.g., SRV-84932)
        const sysId = 'SRV-' + Math.floor(10000 + Math.random() * 90000);

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert into database
        await pool.query(
            'INSERT INTO users (id, full_name, phone, cnic, email, password, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [sysId, fullName, phone, cnic, email, hashedPassword, userRole]
        );

        // Generate JWT Token so they can auto-login
        const token = jwt.sign({ id: sysId, email: email }, JWT_SECRET, { expiresIn: '24h' });

        // Clear OTP after successful registration
        otpStore.delete(email);

        res.status(201).json({ message: 'User registered successfully!', id: sysId, role: userRole, token: token });
    } catch (error) {
        console.error('Register Error:', error);
        res.status(500).json({ error: 'Failed to register user.' });
    }
});

// LOGIN API
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Find user by email
        const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = users[0];

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        // Generate JWT Token
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

        res.json({ message: 'Login successful', token: token, role: user.role });
    } catch (error) {
        console.error('Login Error:', error);
        res.status(500).json({ error: 'Failed to login.' });
    }
});

// FORGOT PASSWORD - Send OTP
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        // Check if user exists
        const [users] = await pool.query('SELECT email FROM users WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'No account found with this email address.' });
        }

        // Generate 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        otpStore.set(email, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });

        // Attempt to send email
        let nodemailer;
        try { nodemailer = require('nodemailer'); } catch (e) { }

        if (nodemailer && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            try {
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
                });
                await transporter.sendMail({
                    from: process.env.EMAIL_USER,
                    to: email,
                    subject: 'ServeIN - Password Reset OTP',
                    text: `Your OTP for resetting your ServeIN password is: ${otp}. It is valid for 10 minutes.`
                });
                console.log(`✅ Reset OTP sent to ${email}`);
            } catch (mailError) {
                console.error('❌ Reset Mail Failed:', mailError.message);
                return res.status(400).json({ error: 'Email address not found or delivery failed. Please check your email.' });
            }
        } else {
            console.log(`[MOCK RESET EMAIL] OTP for ${email} is ${otp}`);
        }

        res.json({ message: 'Reset OTP sent successfully.' });
    } catch (error) {
        console.error('Forgot Password Error:', error);
        res.status(500).json({ error: 'Failed to process request.' });
    }
});

// VERIFY RESET OTP
app.post('/api/verify-reset-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;

        const storedOtpData = otpStore.get(email);
        if (!storedOtpData || storedOtpData.otp !== otp || storedOtpData.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'Invalid or expired OTP.' });
        }

        res.json({ message: 'OTP verified successfully.' });
    } catch (error) {
        console.error('Verify OTP Error:', error);
        res.status(500).json({ error: 'Failed to verify OTP.' });
    }
});

// RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        // Verify OTP
        const storedOtpData = otpStore.get(email);
        if (!storedOtpData || storedOtpData.otp !== otp || storedOtpData.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'Invalid or expired OTP.' });
        }

        // Hash new password
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Update database
        await pool.query('UPDATE users SET password = ? WHERE email = ?', [hashedPassword, email]);

        // Clear OTP
        otpStore.delete(email);

        res.json({ message: 'Password updated successfully!' });
    } catch (error) {
        console.error('Reset Password Error:', error);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

// GET PROFILE API
app.get('/api/profile', verifyToken, async (req, res) => {
    try {
        // req.user.id comes from the verified JWT token
        const [users] = await pool.query('SELECT id, full_name, phone, email, cnic, role, rating, total_ratings, profile_pic FROM users WHERE id = ?', [req.user.id]);

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Fetch Services Taken (as customer)
        const [taken] = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE customer_id = ? AND status = "completed"',
            [req.user.id]
        );

        // Fetch Services Provided (as provider)
        const [provided] = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE provider_id = ? AND status = "completed"',
            [req.user.id]
        );

        const userData = users[0];
        userData.services_taken = taken[0].count;
        userData.services_provided = provided[0].count;

        res.json(userData);
    } catch (error) {
        console.error('Profile Error:', error);
        res.status(500).json({ error: 'Failed to fetch profile.' });
    }
});

// VERIFY PASSWORD API (for secure mode switching and checking actions)
app.post('/api/verify-password', verifyToken, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: 'Password is required.' });
        }

        // Fetch user from database
        const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const validPassword = await bcrypt.compare(password, users[0].password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        res.json({ message: 'Password verified successfully.' });
    } catch (error) {
        console.error('Verify Password Error:', error);
        res.status(500).json({ error: 'Failed to verify password.' });
    }
});

// UPDATE PROFILE (name and phone)
app.put('/api/profile', verifyToken, async (req, res) => {
    try {
        const { full_name, phone } = req.body;
        if (!full_name && !phone) {
            return res.status(400).json({ error: 'At least name or phone must be provided.' });
        }

        // Fetch current user
        const [users] = await pool.query('SELECT full_name, phone FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

        const updatedName = full_name || users[0].full_name;
        let updatedPhone = phone || users[0].phone;

        // Normalize phone
        if (updatedPhone && updatedPhone.startsWith('3')) updatedPhone = '0' + updatedPhone;

        // Check phone uniqueness (only if phone changed)
        if (phone && phone !== users[0].phone) {
            const rawPhone = updatedPhone.replace(/\D/g, '');
            const normalizedPhone = rawPhone.startsWith('0') ? rawPhone.substring(1) : rawPhone;
            const phoneWithZero = '0' + normalizedPhone;

            const [existing] = await pool.query(
                'SELECT id FROM users WHERE (REPLACE(phone, \'\', \'\') IN (?, ?)) AND id != ?',
                [normalizedPhone, phoneWithZero, req.user.id]
            );
            if (existing.length > 0) {
                return res.status(400).json({ error: 'Phone number is already in use by another account.', field: 'phone' });
            }
        }

        await pool.query(
            'UPDATE users SET full_name = ?, phone = ? WHERE id = ?',
            [updatedName, updatedPhone, req.user.id]
        );

        await createNotification(req.user.id, 'account', 'Your profile information has been updated successfully.');
        res.json({ message: 'Profile updated successfully.' });
    } catch (error) {
        console.error('Update Profile Error:', error);
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// CHANGE PASSWORD
app.put('/api/change-password', verifyToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required.' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
        }

        const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

        const validCurrent = await bcrypt.compare(currentPassword, users[0].password);
        if (!validCurrent) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const isSame = await bcrypt.compare(newPassword, users[0].password);
        if (isSame) {
            return res.status(400).json({ error: 'New password cannot be the same as your current password.' });
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

        await createNotification(req.user.id, 'account', 'Your password has been changed successfully.');
        res.json({ message: 'Password changed successfully.' });
    } catch (error) {
        console.error('Change Password Error:', error);
        res.status(500).json({ error: 'Failed to change password.' });
    }
});

// GET NOTIFICATIONS
app.get('/api/notifications', verifyToken, async (req, res) => {
    try {
        const [notifications] = await pool.query(
            'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
            [req.user.id]
        );
        res.json(notifications);
    } catch (error) {
        console.error('Fetch Notifications Error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications.' });
    }
});

// MARK ALL NOTIFICATIONS AS READ
app.put('/api/notifications/read', verifyToken, async (req, res) => {
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ message: 'All notifications marked as read.' });
    } catch (error) {
        console.error('Mark Notifications Read Error:', error);
        res.status(500).json({ error: 'Failed to mark notifications.' });
    }
});

// GET COMPLETED + CANCELLED BOOKINGS HISTORY FOR CUSTOMER
app.get('/api/bookings/customer/history', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT b.id, b.hours_requested, b.location, b.status, b.created_at,
                   u.full_name as provider_name, so.service_name, so.hourly_rate,
                   r.rating, r.comment
            FROM bookings b
            JOIN users u ON b.provider_id = u.id
            JOIN service_offers so ON b.service_offer_id = so.id
            LEFT JOIN reviews r ON b.id = r.booking_id
            WHERE b.customer_id = ? AND b.status IN ('completed', 'cancelled')
            ORDER BY b.created_at DESC
        `;
        const [history] = await pool.query(query, [req.user.id]);
        res.json(history);
    } catch (error) {
        console.error('Fetch Customer History Error:', error);
        res.status(500).json({ error: 'Failed to fetch booking history.' });
    }
});

// GET COMPLETED BOOKINGS HISTORY FOR PROVIDER
app.get('/api/bookings/provider/history', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT b.id, b.hours_requested, b.location, b.status, b.created_at,
                   u.full_name as customer_name, u.phone as customer_phone,
                   so.service_name, so.hourly_rate,
                   r.rating, r.comment
            FROM bookings b
            JOIN users u ON b.customer_id = u.id
            JOIN service_offers so ON b.service_offer_id = so.id
            LEFT JOIN reviews r ON b.id = r.booking_id
            WHERE b.provider_id = ? AND b.status = 'completed'
            ORDER BY b.created_at DESC
        `;
        const [history] = await pool.query(query, [req.user.id]);
        res.json(history);
    } catch (error) {
        console.error('Fetch Provider History Error:', error);
        res.status(500).json({ error: 'Failed to fetch booking history.' });
    }
});


// UPLOAD PROFILE PICTURE API
app.post('/api/upload-profile-pic', verifyToken, upload.single('profile_pic'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No image uploaded.' });
        }

        const profilePicPath = '/uploads/' + req.file.filename;

        // Update user record
        await pool.query('UPDATE users SET profile_pic = ? WHERE id = ?', [profilePicPath, req.user.id]);

        res.json({ message: 'Profile picture updated successfully', profile_pic: profilePicPath });
    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ error: 'Failed to upload profile picture.' });
    }
});

// REMOVE PROFILE PICTURE API
app.delete('/api/remove-profile-pic', verifyToken, async (req, res) => {
    try {
        await pool.query('UPDATE users SET profile_pic = NULL WHERE id = ?', [req.user.id]);
        res.json({ message: 'Profile picture removed successfully.' });
    } catch (error) {
        console.error('Remove Profile Pic Error:', error);
        res.status(500).json({ error: 'Failed to remove profile picture.' });
    }
});

// GET MY OWN REVIEWS (for authenticated provider)
app.get('/api/my-reviews', verifyToken, async (req, res) => {
    try {
        const [reviews] = await pool.query(
            `SELECT r.rating, r.comment, r.created_at, u.full_name as customer_name
             FROM reviews r
             JOIN users u ON r.customer_id = u.id
             WHERE r.provider_id = ?
             ORDER BY r.created_at DESC`,
            [req.user.id]
        );
        res.json(reviews);
    } catch (error) {
        console.error('Fetch My Reviews Error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews.' });
    }
});

// GET REVIEWS FOR A SPECIFIC PROVIDER (public - for customers viewing provider profile)
app.get('/api/provider/:providerId/reviews', async (req, res) => {
    try {
        const { providerId } = req.params;
        const [reviews] = await pool.query(
            `SELECT r.rating, r.comment, r.created_at, u.full_name as customer_name
             FROM reviews r
             JOIN users u ON r.customer_id = u.id
             WHERE r.provider_id = ?
             ORDER BY r.created_at DESC`,
            [providerId]
        );
        res.json(reviews);
    } catch (error) {
        console.error('Fetch Provider Reviews Error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews.' });
    }
});

// DELETE ACCOUNT API
app.delete('/api/account', verifyToken, async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: 'Password is required to delete account.' });

        // Verify password
        const [users] = await pool.query('SELECT password FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

        const validPassword = await bcrypt.compare(password, users[0].password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        // Deactivating service offers
        await pool.query('UPDATE service_offers SET is_active = FALSE WHERE provider_id = ?', [req.user.id]);

        // Cancel any pending or accepted bookings
        await pool.query(
            "UPDATE bookings SET status = 'cancelled' WHERE (customer_id = ? OR provider_id = ?) AND status IN ('pending', 'accepted')",
            [req.user.id, req.user.id]
        );

        // Anonymize user details to clear personal info but preserve database constraints and booking/reviews history
        const dummyEmail = `deleted_${req.user.id}_${Date.now()}@servein.com`;
        await pool.query(
            `UPDATE users SET 
                full_name = 'Deleted User', 
                email = ?, 
                phone = 'Deleted', 
                cnic = 'Deleted', 
                password = 'deleted', 
                profile_pic = NULL,
                role = 'customer'
             WHERE id = ?`,
            [dummyEmail, req.user.id]
        );

        res.json({ message: 'Account deleted successfully.' });
    } catch (error) {
        console.error('Delete Account Error:', error);
        res.status(500).json({ error: 'Failed to delete account.' });
    }
});

// --- PROVIDER SERVICE API ---

// Register Customer as Service Provider
app.post('/api/provider/register', verifyToken, async (req, res) => {
    try {
        const { serviceName } = req.body;
        if (!serviceName) {
            return res.status(400).json({ error: 'Service name is required.' });
        }

        // Check if user exists
        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        // Update user's role to provider
        await pool.query('UPDATE users SET role = "provider" WHERE id = ?', [req.user.id]);

        // Check if service offer already exists (update it) or create a new one
        const [existing] = await pool.query('SELECT id FROM service_offers WHERE provider_id = ?', [req.user.id]);
        if (existing.length > 0) {
            await pool.query(
                'UPDATE service_offers SET service_name = ?, is_active = FALSE WHERE provider_id = ?',
                [serviceName, req.user.id]
            );
        } else {
            await pool.query(
                'INSERT INTO service_offers (provider_id, service_name, hourly_rate, is_active) VALUES (?, ?, 0, FALSE)',
                [req.user.id, serviceName]
            );
        }

        res.json({ message: 'Registered as service provider successfully!' });
    } catch (error) {
        console.error('Provider Register Error:', error);
        res.status(500).json({ error: 'Failed to register as provider.' });
    }
});

// Update/Shift Provider's Service
app.put('/api/provider/service', verifyToken, async (req, res) => {
    try {
        const { serviceName } = req.body;
        if (!serviceName) {
            return res.status(400).json({ error: 'Service name is required.' });
        }

        // Confirm user is provider
        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0 || users[0].role !== 'provider') {
            return res.status(403).json({ error: 'Only providers can update services.' });
        }

        // Update their single service offer and mark it inactive (must manually offer service)
        const [existing] = await pool.query('SELECT id FROM service_offers WHERE provider_id = ?', [req.user.id]);
        if (existing.length > 0) {
            await pool.query(
                'UPDATE service_offers SET service_name = ?, is_active = FALSE WHERE provider_id = ?',
                [serviceName, req.user.id]
            );
        } else {
            await pool.query(
                'INSERT INTO service_offers (provider_id, service_name, hourly_rate, is_active) VALUES (?, ?, 0, FALSE)',
                [req.user.id, serviceName]
            );
        }

        res.json({ message: 'Specialty service updated successfully!' });
    } catch (error) {
        console.error('Update Provider Service Error:', error);
        res.status(500).json({ error: 'Failed to update service.' });
    }
});

// Go Live / Offer Service with a custom rate
app.put('/api/provider/service/offer', verifyToken, async (req, res) => {
    try {
        const { hourlyRate } = req.body;
        if (!hourlyRate || isNaN(hourlyRate) || parseInt(hourlyRate) < 1) {
            return res.status(400).json({ error: 'A valid hourly rate is required.' });
        }

        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0 || users[0].role !== 'provider') {
            return res.status(403).json({ error: 'Only providers can offer services.' });
        }

        await pool.query(
            'UPDATE service_offers SET hourly_rate = ?, is_active = TRUE WHERE provider_id = ?',
            [parseInt(hourlyRate), req.user.id]
        );

        res.json({ message: 'Service offered successfully!' });
    } catch (error) {
        console.error('Offer Service Error:', error);
        res.status(500).json({ error: 'Failed to offer service.' });
    }
});

// Go Offline / Cancel Service Offer
app.put('/api/provider/service/offline', verifyToken, async (req, res) => {
    try {
        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0 || users[0].role !== 'provider') {
            return res.status(403).json({ error: 'Only providers can modify service status.' });
        }

        // Check if there are pending booking requests for this provider
        const [pending] = await pool.query(
            "SELECT id FROM bookings WHERE provider_id = ? AND status = 'pending'",
            [req.user.id]
        );
        if (pending.length > 0) {
            return res.status(400).json({ error: 'Cannot go offline. You have pending booking requests. Please accept or reject them first.' });
        }

        await pool.query(
            'UPDATE service_offers SET is_active = FALSE WHERE provider_id = ?',
            [req.user.id]
        );

        res.json({ message: 'Service taken offline.' });
    } catch (error) {
        console.error('Go Offline Error:', error);
        res.status(500).json({ error: 'Failed to take service offline.' });
    }
});

// Create a service offer (Provider only)
app.post('/api/services', verifyToken, async (req, res) => {
    try {
        const { serviceName, hourlyRate } = req.body;

        const [users] = await pool.query('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0 || users[0].role !== 'provider') {
            return res.status(403).json({ error: 'Only providers can offer services.' });
        }

        await pool.query(
            'INSERT INTO service_offers (provider_id, service_name, hourly_rate) VALUES (?, ?, ?)',
            [req.user.id, serviceName, hourlyRate]
        );

        res.status(201).json({ message: 'Service offered successfully!' });
    } catch (error) {
        console.error('Create Service Error:', error);
        res.status(500).json({ error: 'Failed to create service offer.' });
    }
});

// Get all active services
app.get('/api/services', async (req, res) => {
    try {
        const query = `
            SELECT so.id, so.service_name, so.hourly_rate, u.id as provider_id, u.full_name as provider_name, u.rating, u.total_ratings, u.phone,
                   (SELECT COUNT(*) FROM bookings WHERE provider_id = u.id AND status = 'completed') as services_provided
            FROM service_offers so 
            JOIN users u ON so.provider_id = u.id 
            WHERE so.is_active = TRUE
              AND u.id NOT IN (
                  SELECT provider_id FROM bookings WHERE status IN ('pending', 'accepted')
              )
        `;
        const [services] = await pool.query(query);
        res.json(services);
    } catch (error) {
        console.error('Fetch Services Error:', error);
        res.status(500).json({ error: 'Failed to fetch services.' });
    }
});

// --- BOOKING API ---

// Create a booking request (Customer only)
app.post('/api/bookings', verifyToken, async (req, res) => {
    try {
        const { serviceOfferId, hours, location } = req.body;

        // Get the provider details from the service offer
        const [offers] = await pool.query('SELECT provider_id FROM service_offers WHERE id = ?', [serviceOfferId]);
        if (offers.length === 0) {
            return res.status(404).json({ error: 'Service offer not found.' });
        }

        const providerId = offers[0].provider_id;

        const [result] = await pool.query(
            'INSERT INTO bookings (customer_id, provider_id, service_offer_id, hours_requested, location) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, providerId, serviceOfferId, hours, location]
        );

        // Fetch customer name for notification
        const [cust] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
        const customerName = cust[0] ? cust[0].full_name : 'A customer';

        // Fetch service name for notification
        const [so] = await pool.query('SELECT service_name FROM service_offers WHERE id = ?', [serviceOfferId]);
        const serviceName = so[0] ? so[0].service_name : 'service';

        await createNotification(providerId, 'booking', `${customerName} sent you a booking request for ${serviceName}.`);

        res.status(201).json({ message: 'Booking request sent successfully!', bookingId: result.insertId });
    } catch (error) {
        console.error('Create Booking Error:', error);
        res.status(500).json({ error: 'Failed to create booking.' });
    }
});

// Get pending bookings for a provider
app.get('/api/bookings/provider', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT b.*, u.full_name as customer_name, u.phone as customer_phone, so.service_name, so.hourly_rate 
            FROM bookings b 
            JOIN users u ON b.customer_id = u.id 
            JOIN service_offers so ON b.service_offer_id = so.id 
            WHERE b.provider_id = ? AND b.status = 'pending'
        `;
        const [bookings] = await pool.query(query, [req.user.id]);
        res.json(bookings);
    } catch (error) {
        console.error('Fetch Bookings Error:', error);
        res.status(500).json({ error: 'Failed to fetch bookings.' });
    }
});

// Update booking status (Accept/Reject/Complete/Cancel)
app.put('/api/bookings/:id/status', verifyToken, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { status } = req.body;

        if (!['accepted', 'rejected', 'cancelled', 'completed'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status.' });
        }

        if (status === 'accepted') {
            await pool.query('UPDATE bookings SET status = "accepted" WHERE id = ? AND provider_id = ?', [bookingId, req.user.id]);
            // Deactivate the offer
            const [booking] = await pool.query('SELECT customer_id, service_offer_id FROM bookings WHERE id = ?', [bookingId]);
            if (booking.length > 0) {
                await pool.query('UPDATE service_offers SET is_active = FALSE WHERE id = ?', [booking[0].service_offer_id]);
                // Reject all other pending bookings for this service offer
                await pool.query('UPDATE bookings SET status = "rejected" WHERE service_offer_id = ? AND status = "pending" AND id != ?', [booking[0].service_offer_id, bookingId]);

                // Fetch provider details
                const [prov] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
                const providerName = prov[0] ? prov[0].full_name : 'Provider';
                await createNotification(booking[0].customer_id, 'booking', `${providerName} accepted your booking request.`);
            }
            return res.json({ message: 'Booking accepted.' });
        }

        if (status === 'rejected') {
            await pool.query('UPDATE bookings SET status = "rejected" WHERE id = ? AND provider_id = ?', [bookingId, req.user.id]);
            const [booking] = await pool.query('SELECT customer_id FROM bookings WHERE id = ?', [bookingId]);
            if (booking.length > 0) {
                const [prov] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
                const providerName = prov[0] ? prov[0].full_name : 'Provider';
                await createNotification(booking[0].customer_id, 'booking', `${providerName} rejected your booking request.`);
            }
            return res.json({ message: 'Booking rejected.' });
        }

        if (status === 'cancelled') {
            const [booking] = await pool.query('SELECT customer_id, provider_id, service_offer_id FROM bookings WHERE id = ?', [bookingId]);
            await pool.query('UPDATE bookings SET status = "cancelled" WHERE id = ? AND (customer_id = ? OR provider_id = ?)', [bookingId, req.user.id, req.user.id]);
            if (booking.length > 0) {
                await pool.query('UPDATE service_offers SET is_active = TRUE WHERE id = ?', [booking[0].service_offer_id]);

                const [canceller] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
                const cancellerName = canceller[0] ? canceller[0].full_name : 'The other user';
                const targetId = (req.user.id === booking[0].customer_id) ? booking[0].provider_id : booking[0].customer_id;
                await createNotification(targetId, 'booking', `${cancellerName} cancelled the booking.`);
            }
            return res.json({ message: 'Booking cancelled.' });
        }

        if (status === 'completed') {
            const [booking] = await pool.query('SELECT customer_id, provider_id, service_offer_id, provider_done, customer_done FROM bookings WHERE id = ?', [bookingId]);
            if (booking.length === 0) return res.status(404).json({ error: 'Booking not found.' });

            let providerDone = booking[0].provider_done;
            let customerDone = booking[0].customer_done;

            if (req.user.id === booking[0].provider_id) {
                providerDone = true;
                await pool.query('UPDATE bookings SET provider_done = TRUE WHERE id = ?', [bookingId]);
                const [prov] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
                const providerName = prov[0] ? prov[0].full_name : 'Provider';
                await createNotification(booking[0].customer_id, 'booking', `${providerName} marked the booking as completed.`);
            } else if (req.user.id === booking[0].customer_id) {
                customerDone = true;
                await pool.query('UPDATE bookings SET customer_done = TRUE WHERE id = ?', [bookingId]);
                const [cust] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
                const customerName = cust[0] ? cust[0].full_name : 'Customer';
                await createNotification(booking[0].provider_id, 'booking', `${customerName} marked the booking as completed.`);
            }

            if (providerDone && customerDone) {
                await pool.query('UPDATE bookings SET status = "completed" WHERE id = ?', [bookingId]);
                // Service stays INACTIVE — provider must manually re-offer with a new rate
                await pool.query('UPDATE service_offers SET is_active = FALSE WHERE id = ?', [booking[0].service_offer_id]);

                await createNotification(booking[0].customer_id, 'booking', `Booking is fully completed! You can now leave a review.`);
                await createNotification(booking[0].provider_id, 'booking', `Booking is fully completed!`);

                return res.json({ message: 'Booking fully completed!', fullyCompleted: true });
            } else {
                return res.json({ message: 'Completion marked. Waiting for other party.', fullyCompleted: false });
            }
        }
    } catch (error) {
        console.error('Update Booking Status Error:', error);
        res.status(500).json({ error: 'Failed to update booking status.' });
    }
});

// Get active booking details (for Customer or Provider)
app.get('/api/bookings/active', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT b.*, 
                   c.full_name as customer_name, c.phone as customer_phone, 
                   p.full_name as provider_name, p.phone as provider_phone, 
                   p.rating as provider_rating, p.total_ratings as provider_total_ratings, p.profile_pic as provider_profile_pic,
                   (SELECT COUNT(*) FROM bookings WHERE provider_id = p.id AND status = 'completed') as provider_services_provided,
                   so.service_name, so.hourly_rate 
            FROM bookings b 
            JOIN users c ON b.customer_id = c.id 
            JOIN users p ON b.provider_id = p.id 
            JOIN service_offers so ON b.service_offer_id = so.id 
            WHERE (b.customer_id = ? OR b.provider_id = ?) AND (b.status = 'accepted' OR b.provider_done = TRUE OR b.customer_done = TRUE) AND b.status != 'completed' AND b.status != 'cancelled'
            LIMIT 1
        `;
        const [bookings] = await pool.query(query, [req.user.id, req.user.id]);

        if (bookings.length === 0) {
            return res.status(404).json({ message: 'No active booking found.' });
        }

        res.json(bookings[0]);
    } catch (error) {
        console.error('Fetch Active Booking Error:', error);
        res.status(500).json({ error: 'Failed to fetch active booking.' });
    }
});

// GET PROVIDER'S OWN OFFERS
app.get('/api/services/provider', verifyToken, async (req, res) => {
    try {
        const [offers] = await pool.query('SELECT * FROM service_offers WHERE provider_id = ?', [req.user.id]);
        res.json(offers);
    } catch (error) {
        console.error('Fetch Provider Offers Error:', error);
        res.status(500).json({ error: 'Failed to fetch offered services.' });
    }
});

// DELETE PROVIDER OFFER
app.delete('/api/services/:id', verifyToken, async (req, res) => {
    try {
        const offerId = req.params.id;
        await pool.query('DELETE FROM service_offers WHERE id = ? AND provider_id = ?', [offerId, req.user.id]);
        res.json({ message: 'Service offer cancelled successfully.' });
    } catch (error) {
        console.error('Cancel Service Offer Error:', error);
        res.status(500).json({ error: 'Failed to cancel service offer.' });
    }
});

// GET CUSTOMER'S ACTIVE REQUESTS (For InDrive Request Dialog Polling)
app.get('/api/bookings/customer/active-requests', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT b.*, u.full_name as provider_name, u.rating as provider_rating, so.service_name 
            FROM bookings b
            JOIN users u ON b.provider_id = u.id
            JOIN service_offers so ON b.service_offer_id = so.id
            WHERE b.customer_id = ? AND b.status IN ('pending', 'accepted')
            ORDER BY b.created_at DESC LIMIT 1
        `;
        const [requests] = await pool.query(query, [req.user.id]);
        if (requests.length === 0) {
            return res.json(null);
        }
        res.json(requests[0]);
    } catch (error) {
        console.error('Fetch Active Requests Error:', error);
        res.status(500).json({ error: 'Failed to fetch requests.' });
    }
});

// SEND MESSAGE
app.post('/api/bookings/:id/messages', verifyToken, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'Message content required.' });

        await pool.query(
            'INSERT INTO messages (booking_id, sender_id, message) VALUES (?, ?, ?)',
            [bookingId, req.user.id, message]
        );
        res.status(201).json({ success: true });
    } catch (error) {
        console.error('Send Message Error:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// GET MESSAGES
app.get('/api/bookings/:id/messages', verifyToken, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const [messages] = await pool.query(
            'SELECT m.*, u.full_name as sender_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.booking_id = ? ORDER BY m.created_at ASC',
            [bookingId]
        );
        res.json(messages);
    } catch (error) {
        console.error('Fetch Messages Error:', error);
        res.status(500).json({ error: 'Failed to fetch messages.' });
    }
});

// SUBMIT REVIEW & RATING
app.post('/api/bookings/:id/review', verifyToken, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { rating, comment } = req.body;

        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        }

        const [bookings] = await pool.query('SELECT provider_id, customer_id FROM bookings WHERE id = ?', [bookingId]);
        if (bookings.length === 0) return res.status(404).json({ error: 'Booking not found.' });

        const { provider_id, customer_id } = bookings[0];
        if (req.user.id !== customer_id) {
            return res.status(403).json({ error: 'Only the customer can review this booking.' });
        }

        // Insert review
        await pool.query(
            'INSERT INTO reviews (booking_id, customer_id, provider_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
            [bookingId, customer_id, provider_id, rating, comment]
        );

        // Recalculate Provider's rating
        const [stats] = await pool.query(
            'SELECT COUNT(*) as count, AVG(rating) as avg_rating FROM reviews WHERE provider_id = ?',
            [provider_id]
        );

        const newRating = stats[0].avg_rating || 0.0;
        const totalRatings = stats[0].count || 0;

        await pool.query(
            'UPDATE users SET rating = ?, total_ratings = ? WHERE id = ?',
            [newRating, totalRatings, provider_id]
        );

        // Notify provider
        const [cust] = await pool.query('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
        const customerName = cust[0] ? cust[0].full_name : 'A customer';
        await createNotification(provider_id, 'review', `${customerName} left you a ${rating}-star review.`);

        res.json({ message: 'Review submitted successfully!' });
    } catch (error) {
        console.error('Submit Review Error:', error);
        res.status(500).json({ error: 'Failed to submit review.' });
    }
});

// GET PROVIDER REVIEWS
app.get('/api/providers/:providerId/reviews', async (req, res) => {
    try {
        const providerId = req.params.providerId;
        const [reviews] = await pool.query(
            `SELECT r.rating, r.comment, r.created_at, u.full_name as customer_name
             FROM reviews r
             JOIN users u ON r.customer_id = u.id
             WHERE r.provider_id = ?
             ORDER BY r.created_at DESC LIMIT 5`,
            [providerId]
        );
        res.json(reviews);
    } catch (error) {
        console.error('Fetch Provider Reviews Error:', error);
        res.status(500).json({ error: 'Failed to fetch reviews.' });
    }
});

// RESET PROVIDER DONE — called when customer clicks "Not Done"
app.put('/api/bookings/:id/reset-done', verifyToken, async (req, res) => {
    try {
        const bookingId = req.params.id;
        const [booking] = await pool.query(
            'SELECT customer_id, provider_id FROM bookings WHERE id = ?',
            [bookingId]
        );
        if (booking.length === 0) return res.status(404).json({ error: 'Booking not found.' });
        if (req.user.id !== booking[0].customer_id) {
            return res.status(403).json({ error: 'Only the customer can reset completion status.' });
        }
        await pool.query('UPDATE bookings SET provider_done = FALSE WHERE id = ?', [bookingId]);
        res.json({ message: 'Completion status reset. Provider can re-mark when done.' });
    } catch (error) {
        console.error('Reset Done Error:', error);
        res.status(500).json({ error: 'Failed to reset status.' });
    }
});

// Start Server
app.listen(PORT, async () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    await initDB();
});
