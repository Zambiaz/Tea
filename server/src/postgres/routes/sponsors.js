const express = require('express');
const { pool, transaction, uuid } = require('../store');
const { requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');

const router = express.Router();

function toPublicSponsor(row) {
    return { id: row.id, name: row.name, logoUrl: row.logo_url, enabled: Boolean(row.enabled), createdAt: row.created_at };
}

router.get('/', async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM sponsors WHERE enabled = 1 ORDER BY created_at DESC');
        return res.json({ sponsors: rows.map(toPublicSponsor) });
    } catch (error) { return next(error); }
});

router.get('/admin', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM sponsors ORDER BY created_at DESC');
        return res.json({ sponsors: rows.map(toPublicSponsor) });
    } catch (error) { return next(error); }
});

router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const { name, logoUrl, enabled } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Sponsor name is required.' });
        const id = uuid();
        const sponsor = await transaction(async (client) => {
            await client.query(
                'INSERT INTO sponsors (id, name, logo_url, enabled) VALUES ($1, $2, $3, $4)',
                [id, name, logoUrl || null, enabled === false ? 0 : 1],
            );
            await logAudit(client, { adminId: req.user.id, action: 'sponsor_created', target: id, newValue: req.body });
            const { rows } = await client.query('SELECT * FROM sponsors WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ sponsor: toPublicSponsor(sponsor) });
    } catch (error) { return next(error); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
    try {
        const sponsor = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM sponsors WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const { name, logoUrl, enabled } = req.body || {};
            await client.query(
                'UPDATE sponsors SET name = $1, logo_url = $2, enabled = $3 WHERE id = $4',
                [
                    name ?? existing.name,
                    logoUrl ?? existing.logo_url,
                    enabled === undefined ? existing.enabled : (enabled ? 1 : 0),
                    existing.id,
                ],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'sponsor_updated',
                target: existing.id,
                previousValue: existing,
                newValue: req.body,
            });
            const updated = await client.query('SELECT * FROM sponsors WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!sponsor) return res.status(404).json({ error: 'Sponsor not found.' });
        return res.json({ sponsor: toPublicSponsor(sponsor) });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM sponsors WHERE id = $1 FOR UPDATE', [req.params.id]);
            const sponsor = rows[0];
            if (!sponsor) return false;
            await client.query('DELETE FROM sponsors WHERE id = $1', [sponsor.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'sponsor_deleted',
                target: sponsor.id,
                previousValue: { name: sponsor.name },
            });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Sponsor not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

module.exports = { router, toPublicSponsor };
