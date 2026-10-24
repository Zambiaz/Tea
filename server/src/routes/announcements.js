// Announcements shown to users; managed entirely by admins.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { notifyUser, notifyAdmins } = require('../utils/notifications');

const router = express.Router();

function toPublicAnnouncement(row) {
    return {
        id: row.id,
        title: row.title,
        message: row.message,
        priority: row.priority,
        published: !!row.published,
        publishAt: row.publish_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        publishedAt: row.publish_at || row.created_at,
    };
}

router.get('/', (req, res) => {
    const rows = db.prepare(`
        SELECT * FROM announcements
        WHERE published = 1
          AND (publish_at IS NULL OR publish_at <= datetime('now'))
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY created_at DESC
    `).all();
    res.json({ announcements: rows.map(toPublicAnnouncement) });
});

router.get('/admin', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM announcements ORDER BY created_at DESC').all();
    res.json({ announcements: rows.map(toPublicAnnouncement) });
});

router.post('/', requireAdmin, (req, res) => {
    const { title, message, priority, published, publishAt, expiresAt } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });

    const id = uuid();
    db.prepare(
        'INSERT INTO announcements (id, title, message, priority, published, publish_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, title, message, priority || 'normal', published === false ? 0 : 1, publishAt || null, expiresAt || null);

    logAudit({ adminId: req.user.id, action: 'announcement_created', target: id, newValue: req.body });
    const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
    const recipients = db.prepare("SELECT id FROM users WHERE role = 'user' AND status = 'Active'").all();
    recipients.forEach((user) => notifyUser(user.id, { type: 'announcement', title: announcement.title, message: announcement.message, relatedType: 'announcement', relatedId: id, eventKey: `announcement:${id}:user:${user.id}` }));
    notifyAdmins({ type: 'announcement', title: announcement.title, message: announcement.message, relatedType: 'announcement', relatedId: id, eventKey: `announcement:${id}:admin:${req.user.id}` });
    res.status(201).json({ announcement: toPublicAnnouncement(announcement) });
});

router.patch('/:id', requireAdmin, (req, res) => {
    const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });

    const body = req.body || {};
    db.prepare(
        'UPDATE announcements SET title = ?, message = ?, priority = ?, published = ?, publish_at = ?, expires_at = ? WHERE id = ?',
    ).run(
        body.title ?? announcement.title,
        body.message ?? announcement.message,
        body.priority ?? announcement.priority,
        body.published === undefined ? announcement.published : (body.published ? 1 : 0),
        body.publishAt ?? announcement.publish_at,
        body.expiresAt ?? announcement.expires_at,
        announcement.id,
    );

    logAudit({ adminId: req.user.id, action: 'announcement_updated', target: announcement.id, previousValue: announcement, newValue: body });
    res.json({ announcement: toPublicAnnouncement(db.prepare('SELECT * FROM announcements WHERE id = ?').get(announcement.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
    const announcement = db.prepare('SELECT * FROM announcements WHERE id = ?').get(req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });

    db.prepare('DELETE FROM announcements WHERE id = ?').run(announcement.id);
    logAudit({ adminId: req.user.id, action: 'announcement_deleted', target: announcement.id, previousValue: { title: announcement.title } });
    res.json({ ok: true });
});

module.exports = { router };
