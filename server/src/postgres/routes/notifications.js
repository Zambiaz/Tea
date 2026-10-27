const express = require('express');
const { pool } = require('../store');
const { requireAuth } = require('../middleware');
const { toPublicNotification } = require('../notifications');

const router = express.Router();

router.get('/', requireAuth, async (req, res, next) => {
    try {
        const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
        const since = String(req.query.since || '').trim();
        const parameters = [recipientType, req.user.id];
        let sinceClause = '';
        if (since) {
            if (!Number.isFinite(Date.parse(since))) return res.status(400).json({ error: 'Invalid notification timestamp.' });
            parameters.push(since);
            sinceClause = `AND created_at > $${parameters.length}::timestamptz`;
        }
        const { rows } = await pool.query(`
            SELECT * FROM notifications
            WHERE recipient_type = $1 AND recipient_id = $2 ${sinceClause}
            ORDER BY created_at DESC LIMIT 50
        `, parameters);
        return res.json({ notifications: rows.map(toPublicNotification) });
    } catch (error) { return next(error); }
});

router.post('/:id/read', requireAuth, async (req, res, next) => {
    try {
        const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
        const result = await pool.query(
            `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE id = $1 AND recipient_type = $2 AND recipient_id = $3`,
            [req.params.id, recipientType, req.user.id],
        );
        if (!result.rowCount) return res.status(404).json({ error: 'Notification not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.post('/read-all', requireAuth, async (req, res, next) => {
    try {
        const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
        await pool.query(
            `UPDATE notifications SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
             WHERE recipient_type = $1 AND recipient_id = $2`,
            [recipientType, req.user.id],
        );
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

module.exports = { router };
