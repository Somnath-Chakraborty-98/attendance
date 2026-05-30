const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { validatePassword, passwordErrorMessage } = require('./js/password');
const {
  pgIntervalToMinutes,
  durationInputToPgInterval
} = require('./js/duration');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    max: 1
});
const app = express();

const allowedOrigin = process.env.SITE_URL || '*';
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter(req, file, cb) {
        const allowed = [
            'application/pdf',
            'image/jpeg',
            'image/jpg',
            'image/png',
            'image/gif',
            'image/webp'
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Only PDF and image files are allowed'));
    }
});

const transporter = nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST,
    port: Number(process.env.ZOHO_SMTP_PORT) || 465,
    secure: String(process.env.ZOHO_SMTP_PORT) === '465',
    auth: { user: process.env.ZOHO_SMTP_USER, pass: process.env.ZOHO_SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
});

const ALLOWED_DOC_TYPES = new Set([
    'application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'
]);

function signJwt(payload) {
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function requireAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return res.status(401).json({ error: 'Missing token' });

    try {
        req.user = jwt.verify(m[1], process.env.JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

async function requireAdmin(req, res, next) {
    const client = await pool.connect();
    try {
        const q = await client.query('SELECT is_admin FROM public.users WHERE id=$1', [req.user.sub]);
        if (!q.rowCount || !q.rows[0].is_admin) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    } catch (err) {
        console.error('requireAdmin error', err);
        res.status(500).json({ error: 'Authorization check failed' });
    } finally {
        client.release();
    }
}

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function siteUrl() {
    return (process.env.SITE_URL || 'http://localhost:5500').replace(/\/$/, '');
}

function getMailFrom() {
    const email = (process.env.ZOHO_FROM_EMAIL || process.env.ZOHO_SMTP_USER || '').trim();
    const name = (process.env.ZOHO_FROM_NAME || 'StanzaHR').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('ZOHO_FROM_EMAIL must be a valid email address (e.g. noreply@yourdomain.com)');
    }
    return name ? `"${name.replace(/"/g, '')}" <${email}>` : email;
}

function emailConfigured() {
    return Boolean(
        process.env.ZOHO_SMTP_HOST &&
        process.env.ZOHO_SMTP_USER &&
        process.env.ZOHO_SMTP_PASS &&
        (process.env.ZOHO_FROM_EMAIL || process.env.ZOHO_SMTP_USER)
    );
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildVerificationEmail(name, verifyLink) {
    const brand = process.env.ZOHO_FROM_NAME || 'StanzaHR';
    return `
<!DOCTYPE html>
<html>
<body style="font-family:Segoe UI,sans-serif;background:#f0f2f5;padding:24px;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <h2 style="color:#1a1a2e;margin:0 0 8px;">${escapeHtml(brand)}</h2>
    <p style="color:#666;font-size:14px;margin:0 0 24px;">Confirm your email address</p>
    <p style="color:#334155;font-size:14px;line-height:1.6;">Hi ${escapeHtml(name || 'there')},</p>
    <p style="color:#334155;font-size:14px;line-height:1.6;">Thanks for signing up. Click the button below to verify your account. This link expires in 24 hours.</p>
    <p style="margin:28px 0;">
      <a href="${verifyLink}" style="display:inline-block;background:#0f3460;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">Confirm Email</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.5;">If you did not create an account, you can ignore this email.</p>
  </div>
</body>
</html>`;
}

function buildResetEmail(name, resetLink) {
    const brand = process.env.ZOHO_FROM_NAME || 'StanzaHR';
    return `
<!DOCTYPE html>
<html>
<body style="font-family:Segoe UI,sans-serif;background:#f0f2f5;padding:24px;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
    <h2 style="color:#1a1a2e;margin:0 0 8px;">${escapeHtml(brand)}</h2>
    <p style="color:#666;font-size:14px;margin:0 0 24px;">Password reset</p>
    <p style="color:#334155;font-size:14px;line-height:1.6;">Hi ${escapeHtml(name || 'there')},</p>
    <p style="color:#334155;font-size:14px;line-height:1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
    <p style="margin:28px 0;">
      <a href="${resetLink}" style="display:inline-block;background:#0f3460;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">Reset Password</a>
    </p>
    <p style="color:#94a3b8;font-size:12px;line-height:1.5;">If you did not request this, you can ignore this email.</p>
  </div>
</body>
</html>`;
}

function timeToMinutes(t) {
    if (!t) return 0;
    const parts = String(t).split(':').map(Number);
    return parts[0] * 60 + (parts[1] || 0) + (parts[2] || 0) / 60;
}

function minutesToTime(m) {
    if (m == null || m <= 0) return null;
    const h = Math.floor(m / 60);
    const min = Math.round(m % 60);
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function calcTotalTime(inTime, outTime, breakTime) {
    if (!inTime || !outTime) return null;
    let total = timeToMinutes(outTime) - timeToMinutes(inTime);
    if (breakTime) total -= pgIntervalToMinutes(breakTime);
    return total > 0 ? minutesToTime(total) : '00:00';
}

function mapAttendanceRow(row) {
    return {
        id: row.id,
        date: row.date,
        employee_id: row.employee_id,
        in_time: row.in_time,
        out_time: row.out_time,
        break_time: row.break_time,
        visit_time_from: row.visit_time_from,
        visit_time_to: row.visit_time_to,
        total_time: row.total_time,
        leave: row.on_leave,
        name: row.name,
        created_at: row.created_at
    };
}

async function uploadDocument(file) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'employee-documents';
    if (!supabaseUrl || !serviceKey || !file) return null;

    const ext = path.extname(file.originalname) || '';
    const objectPath = `documents/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

    const res = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': file.mimetype,
            'x-upsert': 'true'
        },
        body: file.buffer
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || 'Document upload failed');
    }

    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function sendMail(options) {
    await withTimeout(transporter.sendMail({
        from: getMailFrom(),
        ...options
    }), 15000, 'Email timed out');
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        env: {
            DATABASE_URL: Boolean(process.env.DATABASE_URL),
            JWT_SECRET: Boolean(process.env.JWT_SECRET),
            SITE_URL: Boolean(process.env.SITE_URL),
            ZOHO_SMTP_HOST: Boolean(process.env.ZOHO_SMTP_HOST),
            SUPABASE_URL: Boolean(process.env.SUPABASE_URL)
        }
    });
});

app.get('/api/db-test', async (req, res) => {
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    let client;
    try {
        client = await withTimeout(pool.connect(), 8000, 'Database connection timed out');
        const result = await withTimeout(client.query('SELECT NOW() AS now'), 8000, 'Database query timed out');
        res.json({ ok: true, now: result.rows[0].now });
    } catch (err) {
        console.error('db-test error', err);
        res.status(500).json({ error: err.message || 'Database test failed' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/schema-test', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('employees', 'departments', 'attendance', 'users')
             ORDER BY table_name, ordinal_position`
        );
        res.json({ ok: true, columns: q.rows });
    } catch (err) {
        console.error('schema-test error', err);
        res.status(500).json({ error: err.message || 'Schema test failed' });
    } finally {
        client.release();
    }
});

app.post('/api/signup', async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' });

    const pwdErr = passwordErrorMessage(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    if (!emailConfigured()) return res.status(500).json({ error: 'Email settings are missing' });

    let client;
    try {
        getMailFrom();
    } catch (err) {
        console.error('signup mail config error', err.message);
        return res.status(500).json({
            error: 'Email sender is misconfigured. Set ZOHO_FROM_EMAIL to your Zoho email address and ZOHO_FROM_NAME to the display name (e.g. StanzaHR).'
        });
    }

    client = await pool.connect();
    try {
        await client.query('BEGIN');

        const exists = await client.query('SELECT id FROM public.users WHERE email=$1', [email]);
        if (exists.rowCount) {
            await client.query('ROLLBACK');
            return res.status(409).json({ error: 'Email already registered' });
        }

        const hash = await bcrypt.hash(password, 10);
        const insert = await client.query(
            'INSERT INTO public.users(email, password_hash, name, is_verified, is_admin) VALUES($1,$2,$3,false,false) RETURNING id',
            [email, hash, name || null]
        );
        const userId = insert.rows[0].id;

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await client.query(
            'INSERT INTO public.email_verifications(user_id, token, expires_at) VALUES($1,$2,$3)',
            [userId, token, expiresAt]
        );

        const verifyLink = `${siteUrl()}/verify.html?token=${token}`;
        await sendMail({
            to: email,
            subject: 'Confirm your StanzaHR account',
            html: buildVerificationEmail(name, verifyLink)
        });

        await client.query('COMMIT');
        res.json({ message: 'confirmation_sent' });
    } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        console.error('signup error', err);
        const msg = err.message || '';
        if (/invalid|recipient|sender|auth|credentials|535|550|553/i.test(msg)) {
            return res.status(500).json({ error: 'Could not send verification email. Check Zoho SMTP settings and that ZOHO_FROM_EMAIL matches your Zoho account.' });
        }
        if (/timed out/i.test(msg)) {
            return res.status(500).json({ error: 'Verification email timed out. Please try again.' });
        }
        res.status(500).json({ error: 'Signup failed. Please try again.' });
    } finally {
        if (client) client.release();
    }
});

app.get('/api/verify', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const client = await pool.connect();
    try {
        const q = await client.query('SELECT user_id, expires_at FROM public.email_verifications WHERE token=$1', [token]);
        if (!q.rowCount) return res.status(400).json({ error: 'Invalid or expired verification link' });
        const row = q.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Verification link has expired' });
        }

        await client.query('UPDATE public.users SET is_verified = true WHERE id=$1', [row.user_id]);
        await client.query('DELETE FROM public.email_verifications WHERE token=$1', [token]);
        res.json({ message: 'verified' });
    } catch (err) {
        console.error('verify error', err);
        res.status(500).json({ error: 'Server error' });
    } finally {
        client.release();
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const client = await pool.connect();
    try {
        const q = await client.query('SELECT id, name FROM public.users WHERE email=$1', [email]);
        if (q.rowCount) {
            const user = q.rows[0];
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
            await client.query('DELETE FROM public.password_resets WHERE user_id=$1', [user.id]);
            await client.query(
                'INSERT INTO public.password_resets(user_id, token, expires_at) VALUES($1,$2,$3)',
                [user.id, token, expiresAt]
            );

            const resetLink = `${siteUrl()}/reset-password.html?token=${token}`;
            await sendMail({
                to: email,
                subject: 'Reset your StanzaHR password',
                html: buildResetEmail(user.name, resetLink)
            });
        }
        res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (err) {
        console.error('forgot-password error', err);
        res.status(500).json({ error: 'Failed to process request' });
    } finally {
        client.release();
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Missing token or password' });

    const pwdErr = passwordErrorMessage(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'SELECT user_id, expires_at FROM public.password_resets WHERE token=$1',
            [token]
        );
        if (!q.rowCount) return res.status(400).json({ error: 'Invalid or expired reset link' });
        const row = q.rows[0];
        if (new Date(row.expires_at) < new Date()) {
            return res.status(400).json({ error: 'Reset link has expired' });
        }

        const hash = await bcrypt.hash(password, 10);
        await client.query('UPDATE public.users SET password_hash=$1 WHERE id=$2', [hash, row.user_id]);
        await client.query('DELETE FROM public.password_resets WHERE token=$1', [token]);
        res.json({ message: 'password_reset' });
    } catch (err) {
        console.error('reset-password error', err);
        res.status(500).json({ error: 'Failed to reset password' });
    } finally {
        client.release();
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET is missing' });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'SELECT id, password_hash, is_verified, name, is_admin FROM public.users WHERE email=$1',
            [email]
        );
        if (!q.rowCount) return res.status(401).json({ error: 'Invalid credentials' });
        const user = q.rows[0];
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
        if (!user.is_verified) return res.status(403).json({ error: 'Email not verified' });

        const token = signJwt({ sub: user.id, name: user.name, email, is_admin: user.is_admin });
        res.json({ token });
    } catch (err) {
        console.error('login error', err);
        res.status(500).json({ error: 'server_error' });
    } finally {
        client.release();
    }
});

app.get('/api/me', async (req, res) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return res.status(401).json({ error: 'Missing token' });

    try {
        const payload = jwt.verify(m[1], process.env.JWT_SECRET);
        const client = await pool.connect();
        try {
            const q = await client.query(
                'SELECT id, email, name, is_verified, is_admin, created_at FROM public.users WHERE id=$1',
                [payload.sub]
            );
            if (!q.rowCount) return res.status(404).json({ error: 'Not found' });
            res.json({ user: q.rows[0] });
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('me error', err);
        return res.status(401).json({ error: 'Invalid token' });
    }
});

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query(
            'SELECT id, email, name, is_verified, is_admin, created_at FROM public.users ORDER BY email ASC'
        );
        res.json({ users: q.rows });
    } catch (err) {
        console.error('users list error', err);
        res.status(500).json({ error: 'Failed to load users' });
    } finally {
        client.release();
    }
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { is_admin } = req.body || {};
    if (typeof is_admin !== 'boolean') return res.status(400).json({ error: 'is_admin must be boolean' });
    if (String(req.params.id) === String(req.user.sub) && !is_admin) {
        return res.status(400).json({ error: 'You cannot remove your own admin access' });
    }

    const client = await pool.connect();
    try {
        const q = await client.query(
            'UPDATE public.users SET is_admin=$1 WHERE id=$2 RETURNING id, email, name, is_verified, is_admin, created_at',
            [is_admin, req.params.id]
        );
        if (!q.rowCount) return res.status(404).json({ error: 'User not found' });
        res.json({ user: q.rows[0] });
    } catch (err) {
        console.error('user update error', err);
        res.status(500).json({ error: 'Failed to update user' });
    } finally {
        client.release();
    }
});

app.get('/api/departments', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query('SELECT id, dep_name FROM public.departments ORDER BY dep_name ASC');
        res.json({ departments: q.rows });
    } catch (err) {
        console.error('departments list error', err);
        res.status(500).json({ error: 'Failed to load departments' });
    } finally {
        client.release();
    }
});

app.post('/api/departments', requireAuth, requireAdmin, async (req, res) => {
    const { dep_name } = req.body || {};
    if (!dep_name || !dep_name.trim()) return res.status(400).json({ error: 'Department name is required' });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'INSERT INTO public.departments(dep_name) VALUES($1) RETURNING id, dep_name',
            [dep_name.trim()]
        );
        res.status(201).json({ department: q.rows[0] });
    } catch (err) {
        console.error('department create error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Department already exists' });
        res.status(500).json({ error: 'Failed to add department' });
    } finally {
        client.release();
    }
});

app.put('/api/departments/:id', requireAuth, requireAdmin, async (req, res) => {
    const { dep_name } = req.body || {};
    if (!dep_name || !dep_name.trim()) return res.status(400).json({ error: 'Department name is required' });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'UPDATE public.departments SET dep_name=$1 WHERE id=$2 RETURNING id, dep_name',
            [dep_name.trim(), req.params.id]
        );
        if (!q.rowCount) return res.status(404).json({ error: 'Department not found' });
        res.json({ department: q.rows[0] });
    } catch (err) {
        console.error('department update error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Department already exists' });
        res.status(500).json({ error: 'Failed to update department' });
    } finally {
        client.release();
    }
});

app.delete('/api/departments/:id', requireAuth, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query('DELETE FROM public.departments WHERE id=$1 RETURNING id', [req.params.id]);
        if (!q.rowCount) return res.status(404).json({ error: 'Department not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('department delete error', err);
        res.status(500).json({ error: 'Failed to delete department' });
    } finally {
        client.release();
    }
});

app.get('/api/employees', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query(
            `SELECT e.id, e.name, e.mobile, e.email_id, e.department_id, e.documents, e.created_at,
                    d.dep_name AS department_name
             FROM public.employees e
             LEFT JOIN public.departments d ON d.id = e.department_id
             ORDER BY e.name ASC`
        );
        res.json({ employees: q.rows });
    } catch (err) {
        console.error('employees list error', err);
        res.status(500).json({ error: 'Failed to load employees' });
    } finally {
        client.release();
    }
});

app.post('/api/employees', requireAuth, requireAdmin, upload.single('document'), async (req, res) => {
    const { name, mobile, email_id, department_id } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Employee name is required' });

    const client = await pool.connect();
    try {
        let documents = null;
        if (req.file) {
            if (!ALLOWED_DOC_TYPES.has(req.file.mimetype)) {
                return res.status(400).json({ error: 'Only PDF and image files are allowed' });
            }
            documents = await uploadDocument(req.file);
        }

        const q = await client.query(
            `INSERT INTO public.employees(name, mobile, email_id, department_id, documents)
             VALUES($1,$2,$3,$4,$5)
             RETURNING id, name, mobile, email_id, department_id, documents, created_at`,
            [
                name.trim(),
                mobile || null,
                email_id || null,
                department_id ? Number(department_id) : null,
                documents
            ]
        );
        res.status(201).json({ employee: q.rows[0] });
    } catch (err) {
        console.error('employee create error', err);
        res.status(500).json({ error: err.message || 'Failed to add employee' });
    } finally {
        client.release();
    }
});

app.put('/api/employees/:id', requireAuth, requireAdmin, upload.single('document'), handleEmployeeUpdate);
app.post('/api/employees/update', requireAuth, requireAdmin, upload.single('document'), (req, res) => {
    req.params.id = req.body.id;
    return handleEmployeeUpdate(req, res);
});

async function handleEmployeeUpdate(req, res) {
    const employeeId = req.params.id;
    if (!employeeId) return res.status(400).json({ error: 'Employee ID is required' });

    const { name, mobile, email_id, department_id, remove_document } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Employee name is required' });

    const client = await pool.connect();
    try {
        const existing = await client.query('SELECT documents FROM public.employees WHERE id=$1', [employeeId]);
        if (!existing.rowCount) return res.status(404).json({ error: 'Employee not found' });

        let documents = existing.rows[0].documents;
        if (remove_document === 'true') documents = null;
        if (req.file) {
            if (!ALLOWED_DOC_TYPES.has(req.file.mimetype)) {
                return res.status(400).json({ error: 'Only PDF and image files are allowed' });
            }
            documents = await uploadDocument(req.file);
        }

        const q = await client.query(
            `UPDATE public.employees
             SET name=$1, mobile=$2, email_id=$3, department_id=$4, documents=$5
             WHERE id=$6
             RETURNING id, name, mobile, email_id, department_id, documents, created_at`,
            [
                name.trim(),
                mobile || null,
                email_id || null,
                department_id ? Number(department_id) : null,
                documents,
                employeeId
            ]
        );
        res.json({ employee: q.rows[0] });
    } catch (err) {
        console.error('employee update error', err);
        res.status(500).json({ error: err.message || 'Failed to update employee' });
    } finally {
        client.release();
    }
}

app.delete('/api/employees/:id', requireAuth, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const emp = await client.query('SELECT id FROM public.employees WHERE id=$1', [req.params.id]);
        if (!emp.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Employee not found' });
        }
        await client.query('DELETE FROM public.employees WHERE id=$1', [req.params.id]);
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('employee delete error', err);
        res.status(500).json({ error: 'Failed to delete employee' });
    } finally {
        client.release();
    }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
    const { date, date_from, date_to, employee_id } = req.query;
    const params = [];
    const where = [];

    if (date) {
        params.push(date);
        where.push(`a.date = $${params.length}`);
    } else if (date_from) {
        if (date_to) {
            params.push(date_from);
            where.push(`a.date >= $${params.length}`);
            params.push(date_to);
            where.push(`a.date <= $${params.length}`);
        } else {
            params.push(date_from);
            where.push(`a.date = $${params.length}`);
        }
    }

    if (employee_id) {
        params.push(Number(employee_id));
        where.push(`a.employee_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const client = await pool.connect();
    try {
        const q = await client.query(
            `SELECT
                a.id, a.date, a.employee_id, a.in_time, a.out_time, a.break_time,
                a.visit_time_from, a.visit_time_to, a.total_time, a.on_leave, a.created_at,
                e.name
             FROM public.attendance a
             LEFT JOIN public.employees e ON e.id = a.employee_id
             ${whereSql}
             ORDER BY a.date DESC, e.name ASC
             LIMIT 500`,
            params
        );
        res.json({ attendance: q.rows.map(mapAttendanceRow) });
    } catch (err) {
        console.error('attendance list error', err);
        res.status(500).json({ error: 'Failed to load attendance' });
    } finally {
        client.release();
    }
});

app.post('/api/attendance', requireAuth, async (req, res) => {
    const {
        date,
        employee_id,
        in_time,
        out_time,
        break_time,
        visit_time_from,
        visit_time_to,
        leave: onLeave
    } = req.body || {};

    if (!date || !employee_id) return res.status(400).json({ error: 'Missing date or employee' });

    const isLeave = Boolean(onLeave);
    const inTime = isLeave ? null : (in_time || null);
    const outTime = isLeave ? null : (out_time || null);
    const breakTime = isLeave ? null : durationInputToPgInterval(break_time);
    const visitFrom = isLeave ? null : (visit_time_from || null);
    const visitTo = isLeave ? null : (visit_time_to || null);
    const totalTime = isLeave ? null : calcTotalTime(inTime, outTime, breakTime);

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT id FROM public.attendance WHERE date=$1 AND employee_id=$2',
            [date, employee_id]
        );

        let q;
        if (existing.rowCount) {
            q = await client.query(
                `UPDATE public.attendance
                 SET in_time=$1, out_time=$2, break_time=$3, visit_time_from=$4, visit_time_to=$5,
                     total_time=$6, on_leave=$7
                 WHERE id=$8
                 RETURNING id, date, employee_id, in_time, out_time, break_time,
                           visit_time_from, visit_time_to, total_time, on_leave, created_at`,
                [inTime, outTime, breakTime, visitFrom, visitTo, totalTime, isLeave, existing.rows[0].id]
            );
        } else {
            q = await client.query(
                `INSERT INTO public.attendance(date, employee_id, in_time, out_time, break_time,
                    visit_time_from, visit_time_to, total_time, on_leave)
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING id, date, employee_id, in_time, out_time, break_time,
                           visit_time_from, visit_time_to, total_time, on_leave, created_at`,
                [date, employee_id, inTime, outTime, breakTime, visitFrom, visitTo, totalTime, isLeave]
            );
        }

        const row = q.rows[0];
        const emp = await client.query('SELECT name FROM public.employees WHERE id=$1', [employee_id]);
        row.name = emp.rows[0]?.name || null;
        res.json({ attendance: mapAttendanceRow(row) });
    } catch (err) {
        console.error('attendance save error', err);
        res.status(500).json({ error: 'Failed to save attendance' });
    } finally {
        client.release();
    }
});

app.delete('/api/attendance/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('DELETE FROM public.attendance WHERE id=$1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        console.error('attendance delete error', err);
        res.status(500).json({ error: 'Failed to delete attendance' });
    } finally {
        client.release();
    }
});

module.exports = app;
