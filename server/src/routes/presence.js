const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getCountry } = require('../utils/countries');

const router = express.Router();
const allowedPages = new Set(['home', 'task', 'product', 'team', 'me', 'history', 'deposit', 'withdraw', 'support']);

router.post('/heartbeat', requireAuth, (req, res) => {
    const page = String(req.body?.page || 'home');
    if (!allowedPages.has(page)) return res.status(400).json({ error: 'Unsupported current page.' });
    db.prepare(`
        INSERT INTO user_presence (user_id, current_page, last_seen_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
            current_page = excluded.current_page,
            last_seen_at = excluded.last_seen_at
    `).run(req.user.id, page);
    res.json({ ok: true });
});

router.get('/', requireAdmin, (req, res) => {
    const search = String(req.query.search || '').trim();
    const params = [];
    let searchFilter = '';
    if (search) {
        searchFilter = 'AND (u.full_name LIKE ? OR u.phone_number LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }
    const users = db.prepare(`
        SELECT u.id, u.full_name, u.phone_number, u.country_code, u.status,
            p.current_page, p.last_seen_at
        FROM user_presence p
        JOIN users u ON u.id = p.user_id
        WHERE u.role = 'user'
            AND u.status = 'Active'
            AND p.last_seen_at >= datetime('now', '-20 seconds')
            ${searchFilter}
        ORDER BY p.last_seen_at DESC
        LIMIT 200
    `).all(...params).map((user) => {
        const country = getCountry(user.country_code);
        return {
            id: user.id,
            fullName: user.full_name,
            phoneNumber: user.phone_number,
            country: country?.name || user.country_code,
            currency: country?.currency || 'RWF',
            status: user.status,
            currentPage: user.current_page,
            lastSeenAt: user.last_seen_at,
        };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ users, onlineCount: users.length, windowSeconds: 20 });
});

module.exports = { router };
