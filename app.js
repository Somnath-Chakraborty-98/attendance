const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const cors = require('cors');
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

const transporter = nodemailer.createTransport({
    host: process.env.ZOHO_SMTP_HOST,
    port: Number(process.env.ZOHO_SMTP_PORT) || 465,
    secure: String(process.env.ZOHO_SMTP_PORT) === '465',
    auth: { user: process.env.ZOHO_SMTP_USER, pass: process.env.ZOHO_SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
});

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

function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        env: {
            DATABASE_URL: Boolean(process.env.DATABASE_URL),
            JWT_SECRET: Boolean(process.env.JWT_SECRET),
            SITE_URL: Boolean(process.env.SITE_URL),
            ZOHO_SMTP_HOST: Boolean(process.env.ZOHO_SMTP_HOST),
            ZOHO_SMTP_PORT: Boolean(process.env.ZOHO_SMTP_PORT),
            ZOHO_SMTP_USER: Boolean(process.env.ZOHO_SMTP_USER),
            ZOHO_SMTP_PASS: Boolean(process.env.ZOHO_SMTP_PASS),
            ZOHO_FROM_EMAIL: Boolean(process.env.ZOHO_FROM_EMAIL)
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

app.get('/api/smtp-test', async (req, res) => {
    if (!process.env.ZOHO_SMTP_HOST || !process.env.ZOHO_SMTP_USER || !process.env.ZOHO_SMTP_PASS || !process.env.ZOHO_FROM_EMAIL) {
        return res.status(500).json({ error: 'Email settings are missing' });
    }

    try {
        await withTimeout(transporter.verify(), 8000, 'SMTP connection timed out');
        res.json({ ok: true });
    } catch (err) {
        console.error('smtp-test error', err);
        res.status(500).json({ error: err.message || 'SMTP test failed' });
    }
});

app.get('/api/schema-test', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query(
            `SELECT table_name, column_name, data_type
             FROM information_schema.columns
             WHERE table_schema = 'public'
               AND table_name IN ('workers', 'attendance')
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
    if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
    if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'DATABASE_URL is missing' });
    if (!process.env.ZOHO_SMTP_HOST || !process.env.ZOHO_SMTP_USER || !process.env.ZOHO_SMTP_PASS || !process.env.ZOHO_FROM_EMAIL) {
        return res.status(500).json({ error: 'Email settings are missing' });
    }

    const client = await pool.connect();
    try {
        const exists = await client.query('SELECT id FROM public.users WHERE email=$1', [email]);
        if (exists.rowCount) return res.status(409).json({ error: 'Email already registered' });

        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        const insert = await client.query(
            'INSERT INTO public.users(email, password_hash, name, is_verified) VALUES($1,$2,$3,false) RETURNING id',
            [email, hash, name || null]
        );
        const userId = insert.rows[0].id;

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await client.query(
            'INSERT INTO public.email_verifications(user_id, token, expires_at) VALUES($1,$2,$3)',
            [userId, token, expiresAt]
        );

        const siteUrl = process.env.SITE_URL || 'http://localhost:5500';
        const verifyLink = `${siteUrl.replace(/\/$/, '')}/api/verify?token=${token}`;

        await withTimeout(transporter.sendMail({
            from: process.env.ZOHO_FROM_EMAIL,
            to: email,
            subject: 'Confirm your account',
            html: `<p>Hi ${name || ''},</p><p>Please confirm your email by clicking the link below:</p><p><a href="${verifyLink}">Confirm email</a></p>`
        }), 8000, 'Confirmation email timed out');

        res.json({ message: 'confirmation_sent' });
    } catch (err) {
        console.error('signup error', err);
        res.status(500).json({ error: 'server_error' });
    } finally {
        client.release();
    }
});

app.get('/api/verify', async (req, res) => {
    const token = req.query.token;
    if (!token) return res.status(400).send('Missing token');
    const client = await pool.connect();
    try {
        const q = await client.query('SELECT user_id, expires_at FROM public.email_verifications WHERE token=$1', [token]);
        if (!q.rowCount) return res.status(400).send('Invalid token');
        const row = q.rows[0];
        if (new Date(row.expires_at) < new Date()) return res.status(400).send('Token expired');

        await client.query('UPDATE public.users SET is_verified = true WHERE id=$1', [row.user_id]);
        await client.query('DELETE FROM public.email_verifications WHERE token=$1', [token]);

        res.send('Email verified - you can now sign in.');
    } catch (err) {
        console.error('verify error', err);
        res.status(500).send('Server error');
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
        const q = await client.query('SELECT id, password_hash, is_verified, name FROM public.users WHERE email=$1', [email]);
        if (!q.rowCount) return res.status(401).json({ error: 'Invalid credentials' });
        const user = q.rows[0];
        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
        if (!user.is_verified) return res.status(403).json({ error: 'Email not verified' });

        const token = signJwt({ sub: user.id, name: user.name, email });
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
    const token = m[1];
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const client = await pool.connect();
        try {
            const q = await client.query('SELECT id, email, name, is_verified, created_at FROM public.users WHERE id=$1', [payload.sub]);
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

app.get('/api/workers', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        const q = await client.query('SELECT id, workerid AS worker_id, name FROM public.workers ORDER BY workerid ASC');
        res.json({ workers: q.rows });
    } catch (err) {
        console.error('workers list error', err);
        res.status(500).json({ error: err.message || 'Failed to load workers' });
    } finally {
        client.release();
    }
});

app.post('/api/workers', requireAuth, async (req, res) => {
    const { worker_id, name } = req.body || {};
    if (!worker_id || !name) return res.status(400).json({ error: 'Missing worker ID or name' });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'INSERT INTO public.workers(workerid, name) VALUES($1,$2) RETURNING id, workerid AS worker_id, name',
            [worker_id, name]
        );
        res.status(201).json({ worker: q.rows[0] });
    } catch (err) {
        console.error('worker create error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Worker ID already exists' });
        res.status(500).json({ error: err.message || 'Failed to add worker' });
    } finally {
        client.release();
    }
});

app.put('/api/workers/:id', requireAuth, async (req, res) => {
    const { worker_id, name } = req.body || {};
    if (!worker_id || !name) return res.status(400).json({ error: 'Missing worker ID or name' });

    const client = await pool.connect();
    try {
        const q = await client.query(
            'UPDATE public.workers SET workerid=$1, name=$2 WHERE id=$3 RETURNING id, workerid AS worker_id, name',
            [worker_id, name, req.params.id]
        );
        if (!q.rowCount) return res.status(404).json({ error: 'Worker not found' });
        res.json({ worker: q.rows[0] });
    } catch (err) {
        console.error('worker update error', err);
        if (err.code === '23505') return res.status(409).json({ error: 'Worker ID already exists' });
        res.status(500).json({ error: err.message || 'Failed to update worker' });
    } finally {
        client.release();
    }
});

app.delete('/api/workers/:id', requireAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const worker = await client.query('SELECT workerid AS worker_id FROM public.workers WHERE id=$1', [req.params.id]);
        if (!worker.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Worker not found' });
        }

        await client.query('DELETE FROM public.attendance WHERE workerid=$1', [worker.rows[0].worker_id]);
        await client.query('DELETE FROM public.workers WHERE id=$1', [req.params.id]);
        await client.query('COMMIT');
        res.json({ ok: true });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('worker delete error', err);
        res.status(500).json({ error: err.message || 'Failed to delete worker' });
    } finally {
        client.release();
    }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
    const { date, worker_id } = req.query;
    const params = [];
    const where = [];

    if (date) {
        params.push(date);
        where.push(`a.date = $${params.length}`);
    }
    if (worker_id) {
        params.push(worker_id);
        where.push(`a.workerid = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const client = await pool.connect();
    try {
        const q = await client.query(
            `SELECT
                a.id,
                a.date,
                a.workerid AS worker_id,
                a.intime AS in_time,
                a.outtime AS out_time,
                a.visittimefrom AS visit_time_from,
                a.visittimeto AS visit_time_to,
                w.name
             FROM public.attendance a
             LEFT JOIN public.workers w ON w.workerid = a.workerid
             ${whereSql}
             ORDER BY a.date DESC, a.workerid ASC
             LIMIT 200`,
            params
        );
        res.json({ attendance: q.rows });
    } catch (err) {
        console.error('attendance list error', err);
        res.status(500).json({ error: 'Failed to load attendance' });
    } finally {
        client.release();
    }
});

app.post('/api/attendance', requireAuth, async (req, res) => {
    const { date, worker_id, in_time, out_time, visit_time_from, visit_time_to } = req.body || {};
    if (!date || !worker_id) return res.status(400).json({ error: 'Missing date or worker' });

    const client = await pool.connect();
    try {
        const existing = await client.query(
            'SELECT id FROM public.attendance WHERE date=$1 AND workerid=$2',
            [date, worker_id]
        );

        let q;
        if (existing.rowCount) {
            q = await client.query(
                `UPDATE public.attendance
                 SET intime=$1, outtime=$2, visittimefrom=$3, visittimeto=$4
                 WHERE id=$5
                 RETURNING
                    id,
                    date,
                    workerid AS worker_id,
                    intime AS in_time,
                    outtime AS out_time,
                    visittimefrom AS visit_time_from,
                    visittimeto AS visit_time_to`,
                [in_time || null, out_time || null, visit_time_from || null, visit_time_to || null, existing.rows[0].id]
            );
        } else {
            q = await client.query(
                `INSERT INTO public.attendance(date, workerid, intime, outtime, visittimefrom, visittimeto)
                 VALUES($1,$2,$3,$4,$5,$6)
                 RETURNING
                    id,
                    date,
                    workerid AS worker_id,
                    intime AS in_time,
                    outtime AS out_time,
                    visittimefrom AS visit_time_from,
                    visittimeto AS visit_time_to`,
                [date, worker_id, in_time || null, out_time || null, visit_time_from || null, visit_time_to || null]
            );
        }

        res.json({ attendance: q.rows[0] });
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
