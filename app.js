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

module.exports = app;
