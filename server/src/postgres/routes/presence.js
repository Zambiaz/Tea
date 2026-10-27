const express = require('express');
const { pool } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { getCountry } = require('../../utils/countries');

const router = express.Router();
const allowedPages = new Set(['home', 'task', 'product', 'team', 'me', 'history', 'deposit', 'withdraw', 'support']);

router.post('/heartbeat', requireAuth, async (req, res, next) => {
    try {
        const page = String(req.body?.page || 'home');
        if (!allowedPages.has(page)) return res.status(400).json({ error: 'Unsupported current page.' });
        await pool.query(`
            INSERT INTO user_presence (user_id, current_page, last_seen_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET
                current_page = EXCLUDED.current_page,
                last_seen_at = EXCLUDED.last_seen_at
        `, [req.user.id, page]);
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim();
        const values = [];
        let searchFilter = '';
        if (search) {
            values.push(`%${search}%`);
            searchFilter = `AND (u.full_name ILIKE $1 OR u.phone_number ILIKE $1)`;
        }
        const { rows } = await pool.query(`
            SELECT u.id, u.full_name, u.phone_number, u.country_code, u.status,
                   p.current_page, p.last_seen_at
            FROM user_presence p
            JOIN users u ON u.id = p.user_id
            WHERE u.role = 'user'
              AND u.status = 'Active'
              AND p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'
              ${searchFilter}
            ORDER BY p.last_seen_at DESC
            LIMIT 200
        `, values);
        const users = rows.map((user) => {
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
        return res.json({ users, onlineCount: users.length, windowSeconds: 20 });
    } catch (error) { return next(error); }
});

module.exports = { router };
