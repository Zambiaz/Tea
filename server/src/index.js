const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');

if (require.main === module && !process.env.VERCEL) {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';
const configuredDriver = process.env.BMG_DATABASE_DRIVER;
if (configuredDriver && !['sqlite', 'postgres'].includes(configuredDriver)) {
    throw new Error('BMG_DATABASE_DRIVER must be either sqlite or postgres.');
}
if (process.env.VERCEL && configuredDriver === 'sqlite') {
    throw new Error('SQLite is not supported in the Vercel serverless runtime.');
}
const usePostgres = configuredDriver
    ? configuredDriver === 'postgres'
    : Boolean(process.env.DATABASE_URL || process.env.VERCEL);
const defaultOrigins = [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:5501',
    'http://127.0.0.1:5501',
];
const configuredOrigins = (process.env.FRONTEND_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const vercelOrigins = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
]
    .filter(Boolean)
    .map((host) => {
        try {
            const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(host) ? host : `https://${host}`);
            return url.origin;
        } catch (_) {
            return null;
        }
    })
    .filter(Boolean);
const lanIpv4List = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
const allowedOrigins = new Set([...defaultOrigins, ...configuredOrigins, ...vercelOrigins, ...lanIpv4List.flatMap((address) => [
    `http://${address}:${PORT}`,
    `http://${address}:5500`,
    `http://${address}:5501`,
])]);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        try {
            const parsed = new URL(origin);
            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || lanIpv4List.includes(parsed.hostname)) {
                return callback(null, true);
            }
        } catch (_) {}
        return callback(new Error('Origin is not allowed by BMG CORS policy.'));
    },
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.get('/api/health', async (_req, res) => {
    if (!usePostgres) return res.json({ ok: true });
    try {
        const { ensureReady, pool } = require('./postgres/store');
        await ensureReady();
        await pool.query('SELECT 1');
        return res.json({ ok: true, database: 'postgres' });
    } catch (error) {
        console.error('BMG PostgreSQL health check failed:', error);
        return res.status(503).json({ ok: false, error: 'Database unavailable.' });
    }
});

if (usePostgres) {
    app.locals.databaseDriver = 'postgres';
    const { ensureReady } = require('./postgres/store');
    app.use('/api', async (_req, _res, next) => {
        try { await ensureReady(); return next(); } catch (error) { return next(error); }
    });
    app.use('/api/auth', require('./postgres/routes/auth').router);
    app.use('/api/countries', require('./postgres/routes/countries').router);
    app.use('/api/settings', require('./postgres/routes/settings').router);
    app.use('/api/announcements', require('./postgres/routes/announcements').router);
    app.use('/api/audit-logs', require('./postgres/routes/audit').router);
    app.use('/api/notifications', require('./postgres/routes/notifications').router);
    app.use('/api/overview', require('./postgres/routes/overview').router);
    app.use('/api/presence', require('./postgres/routes/presence').router);
    app.use('/api/sponsors', require('./postgres/routes/sponsors').router);
    app.use('/api/deposits', require('./postgres/routes/deposits').router);
    app.use('/api/withdrawals', require('./postgres/routes/withdrawals').router);
    app.use('/api/team', require('./postgres/routes/team').router);
    app.use('/api/products', require('./postgres/routes/products').router);
    app.use('/api/users', require('./postgres/routes/users').router);
    app.use('/api/tasks', require('./postgres/routes/tasks').router);
    app.use('/api/promoters', require('./postgres/routes/promoters').router);
} else {
    app.locals.databaseDriver = 'sqlite';
    const routes = [
        ['/api/auth', './routes/auth'],
        ['/api/users', './routes/users'],
        ['/api/deposits', './routes/deposits'],
        ['/api/withdrawals', './routes/withdrawals'],
        ['/api/settings', './routes/settings'],
        ['/api/team', './routes/team'],
        ['/api/products', './routes/products'],
        ['/api/sponsors', './routes/sponsors'],
        ['/api/announcements', './routes/announcements'],
        ['/api/tasks', './routes/tasks'],
        ['/api/audit-logs', './routes/audit'],
        ['/api/overview', './routes/overview'],
        ['/api/promoters', './routes/promoters'],
        ['/api/notifications', './routes/notifications'],
        ['/api/countries', './routes/countries'],
        ['/api/presence', './routes/presence'],
    ];
    for (const [mountPath, modulePath] of routes) app.use(mountPath, require(modulePath).router);
}

const frontendDir = path.join(__dirname, '..', '..');
app.use(express.static(frontendDir, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    },
}));
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error.' });
});

if (require.main === module) {
    app.listen(PORT, HOST, () => {
        const addresses = Object.values(os.networkInterfaces()).flat()
            .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
            .map((entry) => entry.address);
        console.log(`BMG ${app.locals.databaseDriver} backend listening on http://localhost:${PORT}`);
        console.log(`BMG backend bound to ${HOST}:${PORT}`);
        addresses.forEach((address) => console.log(`MOBILE ACCESS: http://${address}:${PORT}`));
    });
}

module.exports = app;
