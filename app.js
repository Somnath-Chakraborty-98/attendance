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

async function withClient(fn) {
    const client = await pool.connect();
    try {
        return await fn(client);
    } finally {
        client.release();
    }
}

async function setBootstrap(client) {
    await client.query(`SELECT set_config('app.bootstrap', 'true', true)`);
}

async function setOrgContext(client, organizationId) {
    await client.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
}

async function withBootstrapTx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setBootstrap(client);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function withOrgTx(organizationId, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await setOrgContext(client, organizationId);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

async function getFreePlanId(client) {
    const q = await client.query(
        `SELECT id FROM public.plans WHERE plan_key='free' LIMIT 1`
    );
    if (!q.rowCount) {
        const err = new Error('Free plan is not configured');
        err.status = 500;
        throw err;
    }
    return q.rows[0].id;
}

async function getPlanUsage(client, organizationId) {
    const q = await client.query(
        `SELECT p.plan_key, p.plan_name, p.max_employees,
                (SELECT COUNT(*)::int FROM public.employees e WHERE e.organization_id = $1) AS employee_count
         FROM public.organizations o
         JOIN public.plans p ON p.id = o.plan_id
         WHERE o.id = $1`,
        [organizationId]
    );
    if (!q.rowCount) {
        const err = new Error('Organization not found');
        err.status = 404;
        throw err;
    }
    const row = q.rows[0];
    return {
        plan_key: row.plan_key,
        plan_name: row.plan_name,
        max_employees: row.max_employees,
        employee_count: row.employee_count,
        remaining: row.max_employees != null
            ? Math.max(0, row.max_employees - row.employee_count)
            : null
    };
}

async function assertEmployeeLimit(client, organizationId) {
    const usage = await getPlanUsage(client, organizationId);
    if (usage.max_employees != null && usage.employee_count >= usage.max_employees) {
        const err = new Error(
            `Employee limit reached (${usage.max_employees} on your plan). Upgrade your plan to add more employees.`
        );
        err.status = 403;
        throw err;
    }
    return usage;
}

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

const ORG_KEY_RE = /^[a-z0-9][a-z0-9-]{2,31}$/;

function normalizeOrgKey(key) {
    return String(key || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function validateOrgKeyFormat(key) {
    const normalized = normalizeOrgKey(key);
    if (!ORG_KEY_RE.test(normalized)) return null;
    return normalized;
}

function orgId(req) {
    return req.user?.org_id || null;
}

async function resolveOrgByKey(orgKey) {
    const normalized = validateOrgKeyFormat(orgKey);
    if (!normalized) return null;
    return withClient(async (client) => {
        const q = await client.query(
            'SELECT id, org_name, org_key FROM public.organizations WHERE org_key=$1',
            [normalized]
        );
        return q.rowCount ? q.rows[0] : null;
    });
}

async function requireAdmin(req, res, next) {
    if (!req.user?.org_id) return res.status(403).json({ error: 'Organization context required' });

    try {
        await withOrgTx(req.user.org_id, async (client) => {
            const q = await client.query(
                'SELECT is_admin FROM public.users WHERE id=$1',
                [req.user.sub]
            );
            if (!q.rowCount || !q.rows[0].is_admin) {
                const err = new Error('Admin access required');
                err.status = 403;
                throw err;
            }
        });
        next();
    } catch (err) {
        if (err.status === 403) return res.status(403).json({ error: err.message });
        console.error('requireAdmin error', err);
        res.status(500).json({ error: 'Authorization check failed' });
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
        half_day: row.half_day,
        late_minutes: row.late_minutes,
        late_category: row.late_category,
        name: row.name,
        created_at: row.created_at
    };
}

function mapEmployeeRow(row) {
    return {
        id: row.id,
        name: row.name,
        mobile: row.mobile,
        email_id: row.email_id,
        department_id: row.department_id,
        department_name: row.department_name,
        documents: row.documents,
        track_visit_time: row.track_visit_time,
        joining_date: row.joining_date,
        birthday: row.birthday,
        work_start_time: row.work_start_time,
        annual_leave_days: row.annual_leave_days,
        created_at: row.created_at
    };
}

function parseBool(val) {
    return val === true || val === 'true' || val === '1';
}

function parseOptionalDate(val) {
    if (!val || !String(val).trim()) return null;
    return String(val).trim();
}

function parseOptionalTime(val) {
    if (!val || !String(val).trim()) return null;
    return String(val).trim();
}

function parseEmployeeBody(body) {
    return {
        track_visit_time: parseBool(body.track_visit_time),
        joining_date: parseOptionalDate(body.joining_date),
        birthday: parseOptionalDate(body.birthday),
        work_start_time: parseOptionalTime(body.work_start_time),
        annual_leave_days: body.annual_leave_days
            ? Number(body.annual_leave_days)
            : null
    };
}

function calcLateMetrics(inTime, workStartTime, mildThreshold, severeThreshold) {
    if (!inTime || !workStartTime) return { late_minutes: null, late_category: null };
    const lateMinutes = Math.max(0, Math.round(timeToMinutes(inTime) - timeToMinutes(workStartTime)));
    let late_category = 'on_time';
    if (lateMinutes <= 0) late_category = 'on_time';
    else if (lateMinutes <= mildThreshold) late_category = 'late_5';
    else if (lateMinutes <= severeThreshold) late_category = 'late_15';
    else late_category = 'late_over_15';
    return { late_minutes: lateMinutes, late_category };
}

function leaveDaysFromType(leaveType) {
    if (leaveType === 'first_half' || leaveType === 'second_half') return 0.5;
    return 1;
}

function daysBetweenInclusive(startDate, endDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    const diff = Math.round((end - start) / (24 * 60 * 60 * 1000));
    return diff + 1;
}

function upcomingDateEvents(employees, daysAhead, field, labelFn) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const events = [];
    for (const emp of employees) {
        const raw = emp[field];
        if (!raw) continue;
        const parts = String(raw).slice(0, 10).split('-');
        if (parts.length < 3) continue;
        const month = Number(parts[1]) - 1;
        const day = Number(parts[2]);
        for (let y = today.getFullYear(); y <= today.getFullYear() + 1; y++) {
            const eventDate = new Date(y, month, day);
            const diff = Math.round((eventDate - today) / (24 * 60 * 60 * 1000));
            if (diff >= 0 && diff <= daysAhead) {
                events.push({
                    employee_id: emp.id,
                    name: emp.name,
                    date: eventDate.toISOString().slice(0, 10),
                    days_until: diff,
                    label: labelFn(emp, eventDate, diff)
                });
                break;
            }
        }
    }
    return events.sort((a, b) => a.days_until - b.days_until);
}

const ATTENDANCE_RETURN = `id, date, employee_id, in_time, out_time, break_time,
    visit_time_from, visit_time_to, total_time, on_leave,
    half_day, late_minutes, late_category, created_at`;

const ATTENDANCE_SELECT = `
    a.id, a.date, a.employee_id, a.in_time, a.out_time, a.break_time,
    a.visit_time_from, a.visit_time_to, a.total_time, a.on_leave,
    a.half_day, a.late_minutes, a.late_category, a.created_at`;

const EMPLOYEE_SELECT = `
    e.id, e.name, e.mobile, e.email_id, e.department_id, e.documents,
    e.track_visit_time, e.joining_date, e.birthday, e.work_start_time,
    e.annual_leave_days, e.created_at, d.dep_name AS department_name`;

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
    try {
        const result = await withTimeout(
            withClient((client) => client.query('SELECT NOW() AS now')),
            8000,
            'Database query timed out'
        );
        res.json({ ok: true, now: result.rows[0].now });
    } catch (err) {
        console.error('db-test error', err);
        res.status(500).json({ error: err.message || 'Database test failed' });
    }
});

app.get('/api/schema-test', requireAuth, async (req, res) => {
    try {
        const q = await withClient((client) => client.query(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('employees', 'departments', 'attendance', 'users')
             ORDER BY table_name, ordinal_position`
        ));
        res.json({ ok: true, columns: q.rows });
    } catch (err) {
        console.error('schema-test error', err);
        res.status(500).json({ error: err.message || 'Schema test failed' });
    }
});

app.post('/api/organizations/verify-key', async (req, res) => {
    const { org_key } = req.body || {};
    const org = await resolveOrgByKey(org_key);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json({ valid: true, org_name: org.org_name, org_key: org.org_key });
});

app.get('/api/organizations/check-key', async (req, res) => {
    const normalized = validateOrgKeyFormat(req.query.org_key);
    if (!normalized) return res.status(400).json({ error: 'Invalid organization key format' });

    try {
        const q = await withClient((client) => client.query(
            'SELECT id FROM public.organizations WHERE org_key=$1',
            [normalized]
        ));
        res.json({ available: !q.rowCount });
    } catch (err) {
        console.error('check-key error', err);
        res.status(500).json({ error: 'Failed to check organization key' });
    }
});

app.post('/api/organizations/register', async (req, res) => {
    const { org_name, org_key, admin_name, admin_email, admin_password } = req.body || {};
    if (!org_name || !org_key || !admin_name || !admin_email || !admin_password) {
        return res.status(400).json({ error: 'All organization and admin fields are required' });
    }

    const normalizedKey = validateOrgKeyFormat(org_key);
    if (!normalizedKey) {
        return res.status(400).json({ error: 'Organization key must be 3–32 characters: lowercase letters, numbers, and hyphens' });
    }

    const pwdErr = passwordErrorMessage(admin_password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    if (!emailConfigured()) return res.status(500).json({ error: 'Email settings are missing' });

    try {
        getMailFrom();
    } catch (err) {
        return res.status(500).json({ error: 'Email sender is misconfigured' });
    }

    try {
        const result = await withBootstrapTx(async (client) => {
            const keyExists = await client.query(
                'SELECT id FROM public.organizations WHERE org_key=$1',
                [normalizedKey]
            );
            if (keyExists.rowCount) {
                const err = new Error('Organization key already exists');
                err.status = 409;
                throw err;
            }

            const freePlanId = await getFreePlanId(client);
            const orgInsert = await client.query(
                'INSERT INTO public.organizations(org_name, org_key, plan_id) VALUES($1,$2,$3) RETURNING id, org_name, org_key',
                [org_name.trim(), normalizedKey, freePlanId]
            );
            const organizationId = orgInsert.rows[0].id;
            await setOrgContext(client, organizationId);

            const emailExists = await client.query(
                'SELECT id FROM public.users WHERE email=$1 AND organization_id=$2',
                [admin_email, organizationId]
            );
            if (emailExists.rowCount) {
                const err = new Error('Email already registered in this organization');
                err.status = 409;
                throw err;
            }

            const hash = await bcrypt.hash(admin_password, 10);
            const userInsert = await client.query(
                `INSERT INTO public.users(email, password_hash, name, is_verified, is_admin, organization_id)
                 VALUES($1,$2,$3,false,true,$4) RETURNING id`,
                [admin_email, hash, admin_name.trim(), organizationId]
            );
            const userId = userInsert.rows[0].id;

            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
            await client.query(
                'INSERT INTO public.email_verifications(user_id, token, expires_at) VALUES($1,$2,$3)',
                [userId, token, expiresAt]
            );

            const verifyLink = `${siteUrl()}/verify?token=${token}`;
            await sendMail({
                to: admin_email,
                subject: 'Confirm your StanzaHR admin account',
                html: buildVerificationEmail(admin_name, verifyLink)
            });

            return orgInsert.rows[0];
        });

        res.status(201).json({
            message: 'organization_created',
            organization: result
        });
    } catch (err) {
        if (err.status === 409) return res.status(409).json({ error: err.message });
        console.error('organization register error', err);
        res.status(500).json({ error: 'Failed to create organization' });
    }
});

app.get('/api/verify', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    try {
        await withBootstrapTx(async (client) => {
            const q = await client.query(
                'SELECT user_id, expires_at FROM public.email_verifications WHERE token=$1',
                [token]
            );
            if (!q.rowCount) {
                const err = new Error('Invalid or expired verification link');
                err.status = 400;
                throw err;
            }
            const row = q.rows[0];
            if (new Date(row.expires_at) < new Date()) {
                const err = new Error('Verification link has expired');
                err.status = 400;
                throw err;
            }

            await client.query('UPDATE public.users SET is_verified = true WHERE id=$1', [row.user_id]);
            await client.query('DELETE FROM public.email_verifications WHERE token=$1', [token]);
        });
        res.json({ message: 'verified' });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error('verify error', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email, org_key } = req.body || {};
    if (!email || !org_key) return res.status(400).json({ error: 'Email and organization key are required' });

    const org = await resolveOrgByKey(org_key);
    if (!org) return res.json({ message: 'If an account exists for that email, a reset link has been sent.' });

    try {
        await withOrgTx(org.id, async (client) => {
            const q = await client.query(
                'SELECT id, name FROM public.users WHERE email=$1 AND organization_id=$2',
                [email, org.id]
            );
            if (q.rowCount) {
                const user = q.rows[0];
                const token = crypto.randomBytes(32).toString('hex');
                const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
                await client.query('DELETE FROM public.password_resets WHERE user_id=$1', [user.id]);
                await client.query(
                    'INSERT INTO public.password_resets(user_id, token, expires_at) VALUES($1,$2,$3)',
                    [user.id, token, expiresAt]
                );

                const resetLink = `${siteUrl()}/reset-password?token=${token}`;
                await sendMail({
                    to: email,
                    subject: 'Reset your StanzaHR password',
                    html: buildResetEmail(user.name, resetLink)
                });
            }
        });
        res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
    } catch (err) {
        console.error('forgot-password error', err);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Missing token or password' });

    const pwdErr = passwordErrorMessage(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    try {
        await withBootstrapTx(async (client) => {
            const q = await client.query(
                'SELECT user_id, expires_at FROM public.password_resets WHERE token=$1',
                [token]
            );
            if (!q.rowCount) {
                const err = new Error('Invalid or expired reset link');
                err.status = 400;
                throw err;
            }
            const row = q.rows[0];
            if (new Date(row.expires_at) < new Date()) {
                const err = new Error('Reset link has expired');
                err.status = 400;
                throw err;
            }

            const hash = await bcrypt.hash(password, 10);
            await client.query('UPDATE public.users SET password_hash=$1 WHERE id=$2', [hash, row.user_id]);
            await client.query('DELETE FROM public.password_resets WHERE token=$1', [token]);
        });
        res.json({ message: 'password_reset' });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error('reset-password error', err);
        res.status(500).json({ error: 'Failed to reset password' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password, org_key } = req.body || {};
    if (!email || !password || !org_key) return res.status(400).json({ error: 'Missing credentials or organization key' });
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    if (!process.env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET is missing' });

    const org = await resolveOrgByKey(org_key);
    if (!org) return res.status(401).json({ error: 'Invalid organization key' });

    try {
        const user = await withOrgTx(org.id, async (client) => {
            const q = await client.query(
                `SELECT id, password_hash, is_verified, name, is_admin, organization_id
                 FROM public.users WHERE email=$1 AND organization_id=$2`,
                [email, org.id]
            );
            if (!q.rowCount) return null;
            return q.rows[0];
        });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
        if (!user.is_verified) return res.status(403).json({ error: 'Email not verified' });

        const token = signJwt({
            sub: user.id,
            name: user.name,
            email,
            is_admin: user.is_admin,
            org_id: user.organization_id,
            org_key: org.org_key
        });
        res.json({ token, org_name: org.org_name, org_key: org.org_key });
    } catch (err) {
        console.error('login error', err);
        res.status(500).json({ error: 'server_error' });
    }
});

app.get('/api/me', async (req, res) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return res.status(401).json({ error: 'Missing token' });

    try {
        const payload = jwt.verify(m[1], process.env.JWT_SECRET);
        if (!payload.org_id) return res.status(401).json({ error: 'Invalid token' });

        const user = await withOrgTx(payload.org_id, async (client) => {
            const q = await client.query(
                `SELECT u.id, u.email, u.name, u.is_verified, u.is_admin, u.created_at, u.organization_id,
                        o.org_name, o.org_key
                 FROM public.users u
                 JOIN public.organizations o ON o.id = u.organization_id
                 WHERE u.id=$1`,
                [payload.sub]
            );
            return q.rowCount ? q.rows[0] : null;
        });
        if (!user) return res.status(404).json({ error: 'Not found' });
        res.json({ user });
    } catch (err) {
        console.error('me error', err);
        return res.status(401).json({ error: 'Invalid token' });
    }
});

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
    try {
        const users = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT id, email, name, is_verified, is_admin, created_at
                 FROM public.users WHERE organization_id=$1 ORDER BY email ASC`,
                [orgId(req)]
            );
            return q.rows;
        });
        res.json({ users });
    } catch (err) {
        console.error('users list error', err);
        res.status(500).json({ error: 'Failed to load users' });
    }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
    const { email, password, name, is_admin } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });

    const pwdErr = passwordErrorMessage(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    try {
        const user = await withOrgTx(orgId(req), async (client) => {
            const exists = await client.query(
                'SELECT id FROM public.users WHERE email=$1 AND organization_id=$2',
                [email, orgId(req)]
            );
            if (exists.rowCount) {
                const err = new Error('Email already registered in this organization');
                err.status = 409;
                throw err;
            }

            const hash = await bcrypt.hash(password, 10);
            const q = await client.query(
                `INSERT INTO public.users(email, password_hash, name, is_verified, is_admin, organization_id)
                 VALUES($1,$2,$3,true,$4,$5)
                 RETURNING id, email, name, is_verified, is_admin, created_at`,
                [email, hash, name.trim(), Boolean(is_admin), orgId(req)]
            );
            return q.rows[0];
        });
        res.status(201).json({ user });
    } catch (err) {
        if (err.status === 409) return res.status(409).json({ error: err.message });
        console.error('user create error', err);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const { is_admin } = req.body || {};
    if (typeof is_admin !== 'boolean') return res.status(400).json({ error: 'is_admin must be boolean' });
    if (String(req.params.id) === String(req.user.sub) && !is_admin) {
        return res.status(400).json({ error: 'You cannot remove your own admin access' });
    }

    try {
        const user = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `UPDATE public.users SET is_admin=$1
                 WHERE id=$2 AND organization_id=$3
                 RETURNING id, email, name, is_verified, is_admin, created_at`,
                [is_admin, req.params.id, orgId(req)]
            );
            if (!q.rowCount) {
                const err = new Error('User not found');
                err.status = 404;
                throw err;
            }
            return q.rows[0];
        });
        res.json({ user });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('user update error', err);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

app.get('/api/departments', requireAuth, async (req, res) => {
    try {
        const departments = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'SELECT id, dep_name FROM public.departments WHERE organization_id=$1 ORDER BY dep_name ASC',
                [orgId(req)]
            );
            return q.rows;
        });
        res.json({ departments });
    } catch (err) {
        console.error('departments list error', err);
        res.status(500).json({ error: 'Failed to load departments' });
    }
});

app.post('/api/departments', requireAuth, requireAdmin, async (req, res) => {
    const { dep_name } = req.body || {};
    if (!dep_name || !dep_name.trim()) return res.status(400).json({ error: 'Department name is required' });

    try {
        const department = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'INSERT INTO public.departments(dep_name, organization_id) VALUES($1,$2) RETURNING id, dep_name',
                [dep_name.trim(), orgId(req)]
            );
            return q.rows[0];
        });
        res.status(201).json({ department });
    } catch (err) {
        console.error('department create error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Department already exists' });
        res.status(500).json({ error: 'Failed to add department' });
    }
});

app.put('/api/departments/:id', requireAuth, requireAdmin, async (req, res) => {
    const { dep_name } = req.body || {};
    if (!dep_name || !dep_name.trim()) return res.status(400).json({ error: 'Department name is required' });

    try {
        const department = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'UPDATE public.departments SET dep_name=$1 WHERE id=$2 AND organization_id=$3 RETURNING id, dep_name',
                [dep_name.trim(), req.params.id, orgId(req)]
            );
            if (!q.rowCount) {
                const err = new Error('Department not found');
                err.status = 404;
                throw err;
            }
            return q.rows[0];
        });
        res.json({ department });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('department update error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Department already exists' });
        res.status(500).json({ error: 'Failed to update department' });
    }
});

app.delete('/api/departments/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'DELETE FROM public.departments WHERE id=$1 AND organization_id=$2 RETURNING id',
                [req.params.id, orgId(req)]
            );
            if (!q.rowCount) {
                const err = new Error('Department not found');
                err.status = 404;
                throw err;
            }
        });
        res.json({ ok: true });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('department delete error', err);
        res.status(500).json({ error: 'Failed to delete department' });
    }
});

app.get('/api/employees', requireAuth, async (req, res) => {
    try {
        const employees = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT ${EMPLOYEE_SELECT}
                 FROM public.employees e
                 LEFT JOIN public.departments d ON d.id = e.department_id AND d.organization_id = e.organization_id
                 WHERE e.organization_id=$1
                 ORDER BY e.name ASC`,
                [orgId(req)]
            );
            return q.rows.map(mapEmployeeRow);
        });
        res.json({ employees });
    } catch (err) {
        console.error('employees list error', err);
        res.status(500).json({ error: 'Failed to load employees' });
    }
});

app.post('/api/employees', requireAuth, requireAdmin, upload.single('document'), async (req, res) => {
    const { name, mobile, email_id, department_id } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Employee name is required' });
    const profile = parseEmployeeBody(req.body || {});

    try {
        let documents = null;
        if (req.file) {
            if (!ALLOWED_DOC_TYPES.has(req.file.mimetype)) {
                return res.status(400).json({ error: 'Only PDF and image files are allowed' });
            }
            documents = await uploadDocument(req.file);
        }

        const employee = await withOrgTx(orgId(req), async (client) => {
            await assertEmployeeLimit(client, orgId(req));
            const q = await client.query(
                `INSERT INTO public.employees(
                    name, mobile, email_id, department_id, documents, organization_id,
                    track_visit_time, joining_date, birthday, work_start_time, annual_leave_days
                 )
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                 RETURNING id, name, mobile, email_id, department_id, documents,
                           track_visit_time, joining_date, birthday, work_start_time,
                           annual_leave_days, created_at`,
                [
                    name.trim(),
                    mobile || null,
                    email_id || null,
                    department_id ? Number(department_id) : null,
                    documents,
                    orgId(req),
                    profile.track_visit_time,
                    profile.joining_date,
                    profile.birthday,
                    profile.work_start_time,
                    profile.annual_leave_days
                ]
            );
            return mapEmployeeRow(q.rows[0]);
        });
        res.status(201).json({ employee });
    } catch (err) {
        if (err.status === 403) return res.status(403).json({ error: err.message });
        console.error('employee create error', err);
        res.status(500).json({ error: err.message || 'Failed to add employee' });
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
    const profile = parseEmployeeBody(req.body || {});

    try {
        let documents = null;
        if (req.file) {
            if (!ALLOWED_DOC_TYPES.has(req.file.mimetype)) {
                return res.status(400).json({ error: 'Only PDF and image files are allowed' });
            }
            documents = await uploadDocument(req.file);
        }

        const employee = await withOrgTx(orgId(req), async (client) => {
            const existing = await client.query(
                'SELECT documents FROM public.employees WHERE id=$1 AND organization_id=$2',
                [employeeId, orgId(req)]
            );
            if (!existing.rowCount) {
                const err = new Error('Employee not found');
                err.status = 404;
                throw err;
            }

            let docValue = existing.rows[0].documents;
            if (remove_document === 'true') docValue = null;
            if (documents !== null) docValue = documents;

            const q = await client.query(
                `UPDATE public.employees
                 SET name=$1, mobile=$2, email_id=$3, department_id=$4, documents=$5,
                     track_visit_time=$6, joining_date=$7, birthday=$8,
                     work_start_time=$9, annual_leave_days=$10
                 WHERE id=$11 AND organization_id=$12
                 RETURNING id, name, mobile, email_id, department_id, documents,
                           track_visit_time, joining_date, birthday, work_start_time,
                           annual_leave_days, created_at`,
                [
                    name.trim(),
                    mobile || null,
                    email_id || null,
                    department_id ? Number(department_id) : null,
                    docValue,
                    profile.track_visit_time,
                    profile.joining_date,
                    profile.birthday,
                    profile.work_start_time,
                    profile.annual_leave_days,
                    employeeId,
                    orgId(req)
                ]
            );
            return mapEmployeeRow(q.rows[0]);
        });
        res.json({ employee });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('employee update error', err);
        res.status(500).json({ error: err.message || 'Failed to update employee' });
    }
}

app.delete('/api/employees/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await withOrgTx(orgId(req), async (client) => {
            const emp = await client.query(
                'SELECT id FROM public.employees WHERE id=$1 AND organization_id=$2',
                [req.params.id, orgId(req)]
            );
            if (!emp.rowCount) {
                const err = new Error('Employee not found');
                err.status = 404;
                throw err;
            }
            await client.query(
                'DELETE FROM public.employees WHERE id=$1 AND organization_id=$2',
                [req.params.id, orgId(req)]
            );
        });
        res.json({ ok: true });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('employee delete error', err);
        res.status(500).json({ error: 'Failed to delete employee' });
    }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
    const { date, date_from, date_to, employee_id } = req.query;
    const params = [orgId(req)];
    const where = ['a.organization_id = $1'];

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

    const whereSql = `WHERE ${where.join(' AND ')}`;
    try {
        const attendance = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT ${ATTENDANCE_SELECT}, e.name
                 FROM public.attendance a
                 LEFT JOIN public.employees e ON e.id = a.employee_id AND e.organization_id = a.organization_id
                 ${whereSql}
                 ORDER BY a.date DESC, e.name ASC
                 LIMIT 500`,
                params
            );
            return q.rows.map(mapAttendanceRow);
        });
        res.json({ attendance });
    } catch (err) {
        console.error('attendance list error', err);
        res.status(500).json({ error: 'Failed to load attendance' });
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
        leave: onLeave,
        half_day: halfDay
    } = req.body || {};

    if (!date || !employee_id) return res.status(400).json({ error: 'Missing date or employee' });

    const isLeave = Boolean(onLeave);
    const halfDayVal = isLeave ? null : (halfDay || null);
    const validHalf = halfDayVal === 'first_half' || halfDayVal === 'second_half' ? halfDayVal : null;
    const inTime = isLeave ? null : (in_time || null);
    const outTime = isLeave ? null : (out_time || null);
    const breakTime = isLeave ? null : durationInputToPgInterval(break_time);
    const visitFrom = isLeave ? null : (visit_time_from || null);
    const visitTo = isLeave ? null : (visit_time_to || null);
    const totalTime = isLeave ? null : calcTotalTime(inTime, outTime, breakTime);

    try {
        const row = await withOrgTx(orgId(req), async (client) => {
            const empCheck = await client.query(
                `SELECT e.id, e.work_start_time, o.default_work_start_time,
                        o.late_threshold_mild, o.late_threshold_severe
                 FROM public.employees e
                 JOIN public.organizations o ON o.id = e.organization_id
                 WHERE e.id=$1 AND e.organization_id=$2`,
                [employee_id, orgId(req)]
            );
            if (!empCheck.rowCount) {
                const err = new Error('Employee not found');
                err.status = 400;
                throw err;
            }
            const emp = empCheck.rows[0];
            const workStart = emp.work_start_time || emp.default_work_start_time;
            const late = isLeave
                ? { late_minutes: null, late_category: null }
                : calcLateMetrics(inTime, workStart, emp.late_threshold_mild, emp.late_threshold_severe);

            const existing = await client.query(
                'SELECT id FROM public.attendance WHERE date=$1 AND employee_id=$2 AND organization_id=$3',
                [date, employee_id, orgId(req)]
            );

            let q;
            if (existing.rowCount) {
                q = await client.query(
                    `UPDATE public.attendance
                     SET in_time=$1, out_time=$2, break_time=$3, visit_time_from=$4, visit_time_to=$5,
                         total_time=$6, on_leave=$7, half_day=$8, late_minutes=$9, late_category=$10
                     WHERE id=$11 AND organization_id=$12
                     RETURNING ${ATTENDANCE_RETURN}`,
                    [
                        inTime, outTime, breakTime, visitFrom, visitTo, totalTime,
                        isLeave, validHalf, late.late_minutes, late.late_category,
                        existing.rows[0].id, orgId(req)
                    ]
                );
            } else {
                q = await client.query(
                    `INSERT INTO public.attendance(
                        date, employee_id, in_time, out_time, break_time,
                        visit_time_from, visit_time_to, total_time, on_leave, organization_id,
                        half_day, late_minutes, late_category
                     )
                     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                     RETURNING ${ATTENDANCE_RETURN}`,
                    [
                        date, employee_id, inTime, outTime, breakTime, visitFrom, visitTo,
                        totalTime, isLeave, orgId(req), validHalf, late.late_minutes, late.late_category
                    ]
                );
            }

            const saved = q.rows[0];
            const nameQ = await client.query(
                'SELECT name FROM public.employees WHERE id=$1 AND organization_id=$2',
                [employee_id, orgId(req)]
            );
            saved.name = nameQ.rows[0]?.name || null;
            return saved;
        });
        res.json({ attendance: mapAttendanceRow(row) });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error('attendance save error', err);
        res.status(500).json({ error: 'Failed to save attendance' });
    }
});

app.delete('/api/attendance/:id', requireAuth, async (req, res) => {
    try {
        await withOrgTx(orgId(req), async (client) => {
            await client.query(
                'DELETE FROM public.attendance WHERE id=$1 AND organization_id=$2',
                [req.params.id, orgId(req)]
            );
        });
        res.json({ ok: true });
    } catch (err) {
        console.error('attendance delete error', err);
        res.status(500).json({ error: 'Failed to delete attendance' });
    }
});

// ── Organization plan & settings ──

app.get('/api/organization/plan', requireAuth, async (req, res) => {
    try {
        const plan = await withOrgTx(orgId(req), async (client) => {
            return getPlanUsage(client, orgId(req));
        });
        res.json({ plan });
    } catch (err) {
        console.error('org plan get error', err);
        res.status(500).json({ error: 'Failed to load plan' });
    }
});

app.get('/api/organization/settings', requireAuth, async (req, res) => {
    try {
        const settings = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT default_work_start_time, late_threshold_mild, late_threshold_severe,
                        default_annual_leave_days
                 FROM public.organizations WHERE id=$1`,
                [orgId(req)]
            );
            return q.rows[0];
        });
        res.json({ settings });
    } catch (err) {
        console.error('org settings get error', err);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

app.patch('/api/organization/settings', requireAuth, requireAdmin, async (req, res) => {
    const {
        default_work_start_time,
        late_threshold_mild,
        late_threshold_severe,
        default_annual_leave_days
    } = req.body || {};

    try {
        const settings = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `UPDATE public.organizations
                 SET default_work_start_time = COALESCE($1, default_work_start_time),
                     late_threshold_mild = COALESCE($2, late_threshold_mild),
                     late_threshold_severe = COALESCE($3, late_threshold_severe),
                     default_annual_leave_days = COALESCE($4, default_annual_leave_days)
                 WHERE id=$5
                 RETURNING default_work_start_time, late_threshold_mild, late_threshold_severe,
                           default_annual_leave_days`,
                [
                    default_work_start_time || null,
                    late_threshold_mild != null ? Number(late_threshold_mild) : null,
                    late_threshold_severe != null ? Number(late_threshold_severe) : null,
                    default_annual_leave_days != null ? Number(default_annual_leave_days) : null,
                    orgId(req)
                ]
            );
            return q.rows[0];
        });
        res.json({ settings });
    } catch (err) {
        console.error('org settings patch error', err);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ── Employee timeline ──

app.get('/api/employees/:id/timeline', requireAuth, async (req, res) => {
    try {
        const data = await withOrgTx(orgId(req), async (client) => {
            const empQ = await client.query(
                `SELECT ${EMPLOYEE_SELECT}
                 FROM public.employees e
                 LEFT JOIN public.departments d ON d.id = e.department_id AND d.organization_id = e.organization_id
                 WHERE e.id=$1 AND e.organization_id=$2`,
                [req.params.id, orgId(req)]
            );
            if (!empQ.rowCount) {
                const err = new Error('Employee not found');
                err.status = 404;
                throw err;
            }

            const leaveQ = await client.query(
                `SELECT id, start_date, end_date, leave_type, days_count, reason, created_at
                 FROM public.leave_records
                 WHERE employee_id=$1 AND organization_id=$2
                 ORDER BY start_date DESC LIMIT 50`,
                [req.params.id, orgId(req)]
            );

            const attLeaveQ = await client.query(
                `SELECT date, on_leave, half_day
                 FROM public.attendance
                 WHERE employee_id=$1 AND organization_id=$2
                   AND (on_leave = true OR half_day IS NOT NULL)
                 ORDER BY date DESC LIMIT 50`,
                [req.params.id, orgId(req)]
            );

            return {
                employee: mapEmployeeRow(empQ.rows[0]),
                leave_records: leaveQ.rows,
                attendance_leaves: attLeaveQ.rows
            };
        });
        res.json(data);
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('employee timeline error', err);
        res.status(500).json({ error: 'Failed to load timeline' });
    }
});

// ── Holidays ──

app.get('/api/holidays', requireAuth, async (req, res) => {
    const { year, month } = req.query;
    try {
        const holidays = await withOrgTx(orgId(req), async (client) => {
            const params = [orgId(req)];
            let where = 'organization_id = $1';
            if (year && month) {
                params.push(Number(year), Number(month));
                where += ` AND EXTRACT(YEAR FROM holiday_date) = $2 AND EXTRACT(MONTH FROM holiday_date) = $3`;
            } else if (year) {
                params.push(Number(year));
                where += ' AND EXTRACT(YEAR FROM holiday_date) = $2';
            }
            const q = await client.query(
                `SELECT id, name, holiday_date, created_at FROM public.holidays
                 WHERE ${where} ORDER BY holiday_date ASC`,
                params
            );
            return q.rows;
        });
        res.json({ holidays });
    } catch (err) {
        console.error('holidays list error', err);
        res.status(500).json({ error: 'Failed to load holidays' });
    }
});

app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
    const { name, holiday_date } = req.body || {};
    if (!name || !holiday_date) return res.status(400).json({ error: 'Name and date are required' });

    try {
        const holiday = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `INSERT INTO public.holidays(name, holiday_date, organization_id)
                 VALUES($1,$2,$3) RETURNING id, name, holiday_date, created_at`,
                [name.trim(), holiday_date, orgId(req)]
            );
            return q.rows[0];
        });
        res.status(201).json({ holiday });
    } catch (err) {
        console.error('holiday create error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Holiday already exists for this date' });
        res.status(500).json({ error: 'Failed to add holiday' });
    }
});

app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'DELETE FROM public.holidays WHERE id=$1 AND organization_id=$2 RETURNING id',
                [req.params.id, orgId(req)]
            );
            if (!q.rowCount) {
                const err = new Error('Holiday not found');
                err.status = 404;
                throw err;
            }
        });
        res.json({ ok: true });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('holiday delete error', err);
        res.status(500).json({ error: 'Failed to delete holiday' });
    }
});

// ── Leave records ──

async function computeLeaveBalance(client, organizationId, employeeId, year) {
    const empQ = await client.query(
        `SELECT e.annual_leave_days, o.default_annual_leave_days
         FROM public.employees e
         JOIN public.organizations o ON o.id = e.organization_id
         WHERE e.id=$1 AND e.organization_id=$2`,
        [employeeId, organizationId]
    );
    if (!empQ.rowCount) return null;
    const quota = empQ.rows[0].annual_leave_days ?? empQ.rows[0].default_annual_leave_days ?? 12;

    const takenQ = await client.query(
        `SELECT COALESCE(SUM(days_count), 0)::float AS taken
         FROM public.leave_records
         WHERE employee_id=$1 AND organization_id=$2
           AND EXTRACT(YEAR FROM start_date) = $3`,
        [employeeId, organizationId, year]
    );
    const attQ = await client.query(
        `SELECT COUNT(*) FILTER (WHERE on_leave) +
                COUNT(*) FILTER (WHERE half_day IS NOT NULL) * 0.5 AS taken
         FROM public.attendance
         WHERE employee_id=$1 AND organization_id=$2
           AND EXTRACT(YEAR FROM date) = $3
           AND (on_leave = true OR half_day IS NOT NULL)`,
        [employeeId, organizationId, year]
    );
    const recordTaken = Number(takenQ.rows[0].taken) || 0;
    const attTaken = Number(attQ.rows[0].taken) || 0;
    const taken = recordTaken + attTaken;
    return { quota, taken, remaining: Math.max(0, quota - taken) };
}

app.get('/api/leaves', requireAuth, async (req, res) => {
    const { employee_id, year, month } = req.query;
    const yearNum = year ? Number(year) : new Date().getFullYear();

    try {
        const result = await withOrgTx(orgId(req), async (client) => {
            const params = [orgId(req)];
            let where = 'lr.organization_id = $1';
            if (employee_id) {
                params.push(Number(employee_id));
                where += ` AND lr.employee_id = $${params.length}`;
            }
            if (year) {
                params.push(yearNum);
                where += ` AND EXTRACT(YEAR FROM lr.start_date) = $${params.length}`;
            }
            if (month) {
                params.push(Number(month));
                where += ` AND EXTRACT(MONTH FROM lr.start_date) = $${params.length}`;
            }

            const q = await client.query(
                `SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.leave_type,
                        lr.days_count, lr.reason, lr.created_at, e.name AS employee_name
                 FROM public.leave_records lr
                 JOIN public.employees e ON e.id = lr.employee_id AND e.organization_id = lr.organization_id
                 WHERE ${where}
                 ORDER BY lr.start_date DESC`,
                params
            );

            let balances = [];
            if (employee_id) {
                const bal = await computeLeaveBalance(client, orgId(req), Number(employee_id), yearNum);
                if (bal) balances = [{ employee_id: Number(employee_id), ...bal }];
            } else {
                const emps = await client.query(
                    'SELECT id FROM public.employees WHERE organization_id=$1',
                    [orgId(req)]
                );
                for (const e of emps.rows) {
                    const bal = await computeLeaveBalance(client, orgId(req), e.id, yearNum);
                    if (bal) balances.push({ employee_id: e.id, ...bal });
                }
            }

            return { leaves: q.rows, balances, year: yearNum };
        });
        res.json(result);
    } catch (err) {
        console.error('leaves list error', err);
        res.status(500).json({ error: 'Failed to load leave records' });
    }
});

app.post('/api/leaves', requireAuth, async (req, res) => {
    const { employee_id, start_date, end_date, leave_type, reason } = req.body || {};
    if (!employee_id || !start_date || !end_date) {
        return res.status(400).json({ error: 'Employee and dates are required' });
    }
    const type = ['full', 'first_half', 'second_half'].includes(leave_type) ? leave_type : 'full';
    const daySpan = daysBetweenInclusive(start_date, end_date);
    const daysCount = type === 'full' ? daySpan : leaveDaysFromType(type);

    try {
        const leave = await withOrgTx(orgId(req), async (client) => {
            const emp = await client.query(
                'SELECT id FROM public.employees WHERE id=$1 AND organization_id=$2',
                [employee_id, orgId(req)]
            );
            if (!emp.rowCount) {
                const err = new Error('Employee not found');
                err.status = 400;
                throw err;
            }

            const q = await client.query(
                `INSERT INTO public.leave_records(
                    organization_id, employee_id, start_date, end_date,
                    leave_type, days_count, reason, created_by
                 )
                 VALUES($1,$2,$3,$4,$5,$6,$7,$8)
                 RETURNING id, employee_id, start_date, end_date, leave_type, days_count, reason, created_at`,
                [orgId(req), employee_id, start_date, end_date, type, daysCount, reason || null, req.user.sub]
            );
            return q.rows[0];
        });
        res.status(201).json({ leave });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error('leave create error', err);
        res.status(500).json({ error: 'Failed to create leave record' });
    }
});

app.delete('/api/leaves/:id', requireAuth, async (req, res) => {
    try {
        await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                'DELETE FROM public.leave_records WHERE id=$1 AND organization_id=$2 RETURNING id',
                [req.params.id, orgId(req)]
            );
            if (!q.rowCount) {
                const err = new Error('Leave record not found');
                err.status = 404;
                throw err;
            }
        });
        res.json({ ok: true });
    } catch (err) {
        if (err.status === 404) return res.status(404).json({ error: err.message });
        console.error('leave delete error', err);
        res.status(500).json({ error: 'Failed to delete leave record' });
    }
});

// ── Dashboard ──

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const daysAhead = Number(req.query.days) || 30;

    try {
        const stats = await withOrgTx(orgId(req), async (client) => {
            const orgIdVal = orgId(req);
            const totalQ = await client.query(
                'SELECT COUNT(*)::int AS c FROM public.employees WHERE organization_id=$1',
                [orgIdVal]
            );
            const attQ = await client.query(
                `SELECT employee_id, on_leave, half_day, in_time
                 FROM public.attendance WHERE organization_id=$1 AND date=$2`,
                [orgIdVal, date]
            );
            const holidayQ = await client.query(
                'SELECT 1 FROM public.holidays WHERE organization_id=$1 AND holiday_date=$2 LIMIT 1',
                [orgIdVal, date]
            );
            const leaveQ = await client.query(
                `SELECT DISTINCT employee_id FROM public.leave_records
                 WHERE organization_id=$1 AND $2::date BETWEEN start_date AND end_date`,
                [orgIdVal, date]
            );
            const empQ = await client.query(
                `SELECT id, name, birthday, joining_date FROM public.employees
                 WHERE organization_id=$1`,
                [orgIdVal]
            );

            const presentIds = new Set();
            const leaveIds = new Set();
            attQ.rows.forEach((r) => {
                if (r.on_leave || r.half_day) leaveIds.add(r.employee_id);
                else if (r.in_time) presentIds.add(r.employee_id);
            });
            leaveQ.rows.forEach((r) => leaveIds.add(r.employee_id));

            const isHoliday = holidayQ.rowCount > 0;
            const total = totalQ.rows[0].c;
            let absent = 0;
            for (const emp of empQ.rows) {
                if (presentIds.has(emp.id) || leaveIds.has(emp.id) || isHoliday) continue;
                absent++;
            }

            const birthdays = upcomingDateEvents(
                empQ.rows,
                daysAhead,
                'birthday',
                (e, d, diff) => diff === 0 ? `${e.name}'s birthday today` : `${e.name}'s birthday in ${diff} day(s)`
            );

            return {
                date,
                is_holiday: isHoliday,
                total_employees: total,
                present_today: presentIds.size,
                absent_today: absent,
                on_leave_today: leaveIds.size,
                upcoming_birthdays: birthdays.slice(0, 10)
            };
        });
        res.json({ stats });
    } catch (err) {
        console.error('dashboard stats error', err);
        res.status(500).json({ error: 'Failed to load dashboard stats' });
    }
});

app.get('/api/dashboard/reminders', requireAuth, async (req, res) => {
    const daysAhead = Number(req.query.days) || 30;

    try {
        const reminders = await withOrgTx(orgId(req), async (client) => {
            const empQ = await client.query(
                'SELECT id, name, birthday, joining_date FROM public.employees WHERE organization_id=$1',
                [orgId(req)]
            );
            const birthdayEvents = upcomingDateEvents(
                empQ.rows,
                daysAhead,
                'birthday',
                (e, d, diff) => diff === 0
                    ? `${e.name} — Birthday today`
                    : `${e.name} — Birthday on ${d.toISOString().slice(0, 10)}`
            ).map((ev) => ({
                type: 'birthday',
                employee_id: ev.employee_id,
                name: ev.name,
                date: ev.date,
                days_until: ev.days_until,
                title: ev.label
            }));

            const anniversaryEvents = upcomingDateEvents(
                empQ.rows.filter((e) => e.joining_date),
                daysAhead,
                'joining_date',
                (e, d) => {
                    const years = d.getFullYear() - new Date(String(e.joining_date).slice(0, 10)).getFullYear();
                    return years > 0
                        ? `${e.name} — ${years} year work anniversary`
                        : `${e.name} — Work anniversary`;
                }
            ).map((ev) => ({
                type: 'anniversary',
                employee_id: ev.employee_id,
                name: ev.name,
                date: ev.date,
                days_until: ev.days_until,
                title: ev.label
            }));

            return [...birthdayEvents, ...anniversaryEvents].sort((a, b) => a.days_until - b.days_until);
        });
        res.json({ reminders });
    } catch (err) {
        console.error('dashboard reminders error', err);
        res.status(500).json({ error: 'Failed to load reminders' });
    }
});

// ── Calendar (holidays + team leave) ──

app.get('/api/calendar', requireAuth, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month) || (new Date().getMonth() + 1);

    try {
        const calendar = await withOrgTx(orgId(req), async (client) => {
            const holidays = await client.query(
                `SELECT id, name, holiday_date FROM public.holidays
                 WHERE organization_id=$1
                   AND EXTRACT(YEAR FROM holiday_date)=$2
                   AND EXTRACT(MONTH FROM holiday_date)=$3`,
                [orgId(req), year, month]
            );
            const leaves = await client.query(
                `SELECT lr.id, lr.employee_id, lr.start_date, lr.end_date, lr.leave_type,
                        lr.days_count, e.name AS employee_name
                 FROM public.leave_records lr
                 JOIN public.employees e ON e.id = lr.employee_id AND e.organization_id = lr.organization_id
                 WHERE lr.organization_id=$1
                   AND lr.start_date <= make_date($3::int, $2::int, 1) + interval '1 month' - interval '1 day'
                   AND lr.end_date >= make_date($3::int, $2::int, 1)`,
                [orgId(req), month, year]
            );
            return { year, month, holidays: holidays.rows, leaves: leaves.rows };
        });
        res.json(calendar);
    } catch (err) {
        console.error('calendar error', err);
        res.status(500).json({ error: 'Failed to load calendar' });
    }
});

// ── Reports ──

app.get('/api/reports/attendance', requireAuth, async (req, res) => {
    const { date_from, date_to, employee_id } = req.query;
    if (!date_from) return res.status(400).json({ error: 'date_from is required' });

    const params = [orgId(req)];
    const where = ['a.organization_id = $1'];
    params.push(date_from);
    where.push(`a.date >= $${params.length}`);
    if (date_to) {
        params.push(date_to);
        where.push(`a.date <= $${params.length}`);
    }
    if (employee_id) {
        params.push(Number(employee_id));
        where.push(`a.employee_id = $${params.length}`);
    }

    try {
        const rows = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT ${ATTENDANCE_SELECT}, e.name, d.dep_name AS department_name
                 FROM public.attendance a
                 LEFT JOIN public.employees e ON e.id = a.employee_id AND e.organization_id = a.organization_id
                 LEFT JOIN public.departments d ON d.id = e.department_id AND d.organization_id = e.organization_id
                 WHERE ${where.join(' AND ')}
                 ORDER BY a.date DESC, e.name ASC`,
                params
            );
            return q.rows.map((r) => ({
                ...mapAttendanceRow(r),
                department_name: r.department_name
            }));
        });
        res.json({ report: rows });
    } catch (err) {
        console.error('attendance report error', err);
        res.status(500).json({ error: 'Failed to generate attendance report' });
    }
});

app.get('/api/reports/late', requireAuth, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = req.query.month ? Number(req.query.month) : null;
    const employee_id = req.query.employee_id ? Number(req.query.employee_id) : null;

    try {
        const summary = await withOrgTx(orgId(req), async (client) => {
            const params = [orgId(req), year];
            let where = `a.organization_id = $1 AND EXTRACT(YEAR FROM a.date) = $2
                         AND a.late_category IS NOT NULL AND a.late_category != 'on_time'`;
            if (month) {
                params.push(month);
                where += ` AND EXTRACT(MONTH FROM a.date) = $${params.length}`;
            }
            if (employee_id) {
                params.push(employee_id);
                where += ` AND a.employee_id = $${params.length}`;
            }

            const q = await client.query(
                `SELECT e.id AS employee_id, e.name,
                        COUNT(*) FILTER (WHERE a.late_category = 'late_5')::int AS late_5_count,
                        COUNT(*) FILTER (WHERE a.late_category = 'late_15')::int AS late_15_count,
                        COUNT(*) FILTER (WHERE a.late_category = 'late_over_15')::int AS late_over_15_count,
                        COUNT(*)::int AS total_late
                 FROM public.attendance a
                 JOIN public.employees e ON e.id = a.employee_id AND e.organization_id = a.organization_id
                 WHERE ${where}
                 GROUP BY e.id, e.name
                 ORDER BY total_late DESC, e.name ASC`,
                params
            );
            return q.rows;
        });
        res.json({ year, month, summary });
    } catch (err) {
        console.error('late report error', err);
        res.status(500).json({ error: 'Failed to generate late report' });
    }
});

app.get('/api/reports/leave', requireAuth, async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();

    try {
        const report = await withOrgTx(orgId(req), async (client) => {
            const emps = await client.query(
                `SELECT e.id, e.name, d.dep_name AS department_name,
                        e.annual_leave_days, o.default_annual_leave_days
                 FROM public.employees e
                 JOIN public.organizations o ON o.id = e.organization_id
                 LEFT JOIN public.departments d ON d.id = e.department_id AND d.organization_id = e.organization_id
                 WHERE e.organization_id=$1 ORDER BY e.name`,
                [orgId(req)]
            );

            const monthly = await client.query(
                `SELECT EXTRACT(MONTH FROM start_date)::int AS month,
                        COALESCE(SUM(days_count), 0)::float AS days
                 FROM public.leave_records
                 WHERE organization_id=$1 AND EXTRACT(YEAR FROM start_date)=$2
                 GROUP BY 1 ORDER BY 1`,
                [orgId(req), year]
            );

            const rows = [];
            for (const e of emps.rows) {
                const bal = await computeLeaveBalance(client, orgId(req), e.id, year);
                rows.push({
                    employee_id: e.id,
                    name: e.name,
                    department_name: e.department_name,
                    quota: bal?.quota ?? 12,
                    taken: bal?.taken ?? 0,
                    remaining: bal?.remaining ?? 0
                });
            }
            return { year, employees: rows, monthly: monthly.rows };
        });
        res.json({ report });
    } catch (err) {
        console.error('leave report error', err);
        res.status(500).json({ error: 'Failed to generate leave report' });
    }
});

app.get('/api/reports/employees', requireAuth, async (req, res) => {
    try {
        const report = await withOrgTx(orgId(req), async (client) => {
            const q = await client.query(
                `SELECT ${EMPLOYEE_SELECT}
                 FROM public.employees e
                 LEFT JOIN public.departments d ON d.id = e.department_id AND d.organization_id = e.organization_id
                 WHERE e.organization_id=$1 ORDER BY e.name ASC`,
                [orgId(req)]
            );
            return q.rows.map(mapEmployeeRow);
        });
        res.json({ report });
    } catch (err) {
        console.error('employee report error', err);
        res.status(500).json({ error: 'Failed to generate employee report' });
    }
});

module.exports = app;
