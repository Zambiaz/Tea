// Verifies the bearer JWT on every protected request. The backend is the only source of truth
// for who a request belongs to -- never trust a role claim sent directly from the frontend.
const { verifyToken } = require('../auth');
const { db } = require('../db');

function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    try {
        const payload = verifyToken(token);
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
        if (payload.authVersion === undefined || Number(payload.authVersion) !== Number(user.auth_version || 0)) {
            return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
        }
        if (user.status !== 'Active') {
            return res.status(403).json({ error: `Account is ${user.status.toLowerCase()}.`, status: user.status });
        }
        if (user.login_blocked) return res.status(403).json({ error: 'Login is disabled for this account.', status: 'Blocked' });
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session.' });
    }
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin privileges required.' });
        }
        next();
    });
}

module.exports = { requireAuth, requireAdmin };
