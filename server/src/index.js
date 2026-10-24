// BMG backend entry point. Mounts every domain route under /api and (for convenience)
// also serves the static frontend so the whole app can run from one process if desired.
// The frontend can still be opened separately with Live Server; CORS is left open in dev.
const path = require('path');
const os = require('os');
const express = require('express');
const cors = require('cors');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { router: authRouter } = require('./routes/auth');
const { router: usersRouter } = require('./routes/users');
const { router: depositsRouter } = require('./routes/deposits');
const { router: withdrawalsRouter } = require('./routes/withdrawals');
const { router: settingsRouter } = require('./routes/settings');
const { router: teamRouter } = require('./routes/team');
const { router: productsRouter } = require('./routes/products');
const { router: sponsorsRouter } = require('./routes/sponsors');
const { router: announcementsRouter } = require('./routes/announcements');
const { router: tasksRouter } = require('./routes/tasks');
const { router: auditRouter } = require('./routes/audit');
const { router: overviewRouter } = require('./routes/overview');
const { router: promotersRouter } = require('./routes/promoters');
const { router: notificationsRouter } = require('./routes/notifications');
const { router: countriesRouter } = require('./routes/countries');
const { router: presenceRouter } = require('./routes/presence');

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = '0.0.0.0';

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
const lanIpv4List = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
const lanOrigins = lanIpv4List.flatMap((address) => [
    `http://${address}:${PORT}`,
    `http://${address}:5500`,
    `http://${address}:5501`,
]);
const allowedOrigins = new Set([...defaultOrigins, ...configuredOrigins, ...lanOrigins]);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        try {
            const parsed = new URL(origin);
            if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || lanIpv4List.includes(parsed.hostname)) {
                return callback(null, true);
            }
        } catch (_) {}
        return callback(new Error('Origin is not allowed by BMG local CORS policy.'));
    },
}));
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/deposits', depositsRouter);
app.use('/api/withdrawals', withdrawalsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/team', teamRouter);
app.use('/api/products', productsRouter);
app.use('/api/sponsors', sponsorsRouter);
app.use('/api/announcements', announcementsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/audit-logs', auditRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/promoters', promotersRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/countries', countriesRouter);
app.use('/api/presence', presenceRouter);

// Convenience: serve the static frontend from the same origin so it can be opened
// at http://localhost:4000 without a separate Live Server instance, if preferred.
const frontendDir = path.join(__dirname, '..', '..');
app.use(express.static(frontendDir, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(PORT, HOST, () => {
    const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address);
    console.log(`BMG backend listening on http://localhost:${PORT}`);
    console.log(`BMG backend bound to ${HOST}:${PORT}`);
    addresses.forEach((address) => console.log(`MOBILE ACCESS: http://${address}:${PORT}`));
});
