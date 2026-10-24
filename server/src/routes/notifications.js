const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { toPublicNotification } = require('../utils/notifications');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
    const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
    const since = String(req.query.since || '').trim();
    const rows = db.prepare(`
        SELECT * FROM notifications
        WHERE recipient_type = ? AND recipient_id = ? ${since ? 'AND created_at > ?' : ''}
        ORDER BY created_at DESC LIMIT 50
    `).all(...(since ? [recipientType, req.user.id, since] : [recipientType, req.user.id]));
    res.json({ notifications: rows.map(toPublicNotification) });
});

router.post('/:id/read', requireAuth, (req, res) => {
    const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
    const result = db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND recipient_type = ? AND recipient_id = ?").run(req.params.id, recipientType, req.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
});

router.post('/read-all', requireAuth, (req, res) => {
    const recipientType = req.user.role === 'admin' ? 'admin' : 'user';
    db.prepare("UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE recipient_type = ? AND recipient_id = ?").run(recipientType, req.user.id);
    res.json({ ok: true });
});

module.exports = { router };