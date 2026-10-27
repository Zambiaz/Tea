const { verifyToken } = require('../auth');
const { pool } = require('./store');

async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        const payload = verifyToken(token);
        const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
        const user = rows[0];
        if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
        if (payload.authVersion === undefined || Number(payload.authVersion) !== Number(user.auth_version || 0)) {
            return res.status(401).json({ error: 'Session has been revoked. Please sign in again.' });
        }
        if (user.status !== 'Active') return res.status(403).json({ error: `Account is ${user.status.toLowerCase()}.`, status: user.status });
        if (user.login_blocked) return res.status(403).json({ error: 'Login is disabled for this account.', status: 'Blocked' });
        req.user = user;
        return next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }
        return next(error);
    }
}

function requireAdmin(req, res, next) {
    return requireAuth(req, res, () => {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin privileges required.' });
        return next();
    });
}

module.exports = { requireAuth, requireAdmin };
