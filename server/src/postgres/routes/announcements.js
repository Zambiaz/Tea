const express = require('express');
const { pool, transaction, uuid } = require('../store');
const { requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { notifyAdmins } = require('../notifications');

const router = express.Router();

function toPublicAnnouncement(row) {
    return {
        id: row.id,
        title: row.title,
        message: row.message,
        priority: row.priority,
        published: Boolean(row.published),
        publishAt: row.publish_at,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        publishedAt: row.publish_at || row.created_at,
    };
}

router.get('/', async (_req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT * FROM announcements
            WHERE published = 1
              AND (publish_at IS NULL OR publish_at <= CURRENT_TIMESTAMP)
              AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            ORDER BY created_at DESC
        `);
        return res.json({ announcements: rows.map(toPublicAnnouncement) });
    } catch (error) { return next(error); }
});

router.get('/admin', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC');
        return res.json({ announcements: rows.map(toPublicAnnouncement) });
    } catch (error) { return next(error); }
});

router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const { title, message, priority, published, publishAt, expiresAt } = req.body || {};
        if (!title || !message) return res.status(400).json({ error: 'Title and message are required.' });
        const id = uuid();
        const announcement = await transaction(async (client) => {
            await client.query(
                `INSERT INTO announcements (id, title, message, priority, published, publish_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, title, message, priority || 'normal', published === false ? 0 : 1, publishAt || null, expiresAt || null],
            );
            await logAudit(client, { adminId: req.user.id, action: 'announcement_created', target: id, newValue: req.body });
            const { rows } = await client.query('SELECT * FROM announcements WHERE id = $1', [id]);
            const created = rows[0];
            await client.query(
                `INSERT INTO notifications
                 (id, recipient_type, recipient_id, type, title, message, related_type, related_id, event_key)
                 SELECT gen_random_uuid()::text, 'user', id, 'announcement', $1, $2, 'announcement', $3,
                        $4 || ':user:' || id
                 FROM users WHERE role = 'user' AND status = 'Active'
                 ON CONFLICT (event_key) DO NOTHING`,
                [created.title, created.message, id, `announcement:${id}`],
            );
            await notifyAdmins(client, {
                type: 'announcement',
                title: created.title,
                message: created.message,
                relatedType: 'announcement',
                relatedId: id,
                eventKey: `announcement:${id}`,
            });
            return created;
        });
        return res.status(201).json({ announcement: toPublicAnnouncement(announcement) });
    } catch (error) { return next(error); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
    try {
        const announcement = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM announcements WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const body = req.body || {};
            const values = [
                body.title ?? existing.title,
                body.message ?? existing.message,
                body.priority ?? existing.priority,
                body.published === undefined ? existing.published : (body.published ? 1 : 0),
                body.publishAt ?? existing.publish_at,
                body.expiresAt ?? existing.expires_at,
                existing.id,
            ];
            await client.query(
                `UPDATE announcements
                 SET title = $1, message = $2, priority = $3, published = $4, publish_at = $5, expires_at = $6
                 WHERE id = $7`,
                values,
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'announcement_updated',
                target: existing.id,
                previousValue: existing,
                newValue: body,
            });
            const updated = await client.query('SELECT * FROM announcements WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
        return res.json({ announcement: toPublicAnnouncement(announcement) });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM announcements WHERE id = $1 FOR UPDATE', [req.params.id]);
            const announcement = rows[0];
            if (!announcement) return false;
            await client.query('DELETE FROM announcements WHERE id = $1', [announcement.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'announcement_deleted',
                target: announcement.id,
                previousValue: { title: announcement.title },
            });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Announcement not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

module.exports = { router, toPublicAnnouncement };
