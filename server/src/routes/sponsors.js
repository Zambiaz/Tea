// Sponsor logos shown to users; managed entirely by admins.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');

const router = express.Router();

function toPublicSponsor(row) {
    return { id: row.id, name: row.name, logoUrl: row.logo_url, enabled: !!row.enabled, createdAt: row.created_at };
}

router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM sponsors WHERE enabled = 1 ORDER BY created_at DESC').all();
    res.json({ sponsors: rows.map(toPublicSponsor) });
});

router.get('/admin', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM sponsors ORDER BY created_at DESC').all();
    res.json({ sponsors: rows.map(toPublicSponsor) });
});

router.post('/', requireAdmin, (req, res) => {
    const { name, logoUrl, enabled } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Sponsor name is required.' });

    const id = uuid();
    db.prepare('INSERT INTO sponsors (id, name, logo_url, enabled) VALUES (?, ?, ?, ?)').run(id, name, logoUrl || null, enabled === false ? 0 : 1);
    logAudit({ adminId: req.user.id, action: 'sponsor_created', target: id, newValue: req.body });
    res.status(201).json({ sponsor: toPublicSponsor(db.prepare('SELECT * FROM sponsors WHERE id = ?').get(id)) });
});

router.patch('/:id', requireAdmin, (req, res) => {
    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(req.params.id);
    if (!sponsor) return res.status(404).json({ error: 'Sponsor not found.' });

    const { name, logoUrl, enabled } = req.body || {};
    db.prepare('UPDATE sponsors SET name = ?, logo_url = ?, enabled = ? WHERE id = ?').run(
        name ?? sponsor.name, logoUrl ?? sponsor.logo_url, enabled === undefined ? sponsor.enabled : (enabled ? 1 : 0), sponsor.id,
    );
    logAudit({ adminId: req.user.id, action: 'sponsor_updated', target: sponsor.id, previousValue: sponsor, newValue: req.body });
    res.json({ sponsor: toPublicSponsor(db.prepare('SELECT * FROM sponsors WHERE id = ?').get(sponsor.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
    const sponsor = db.prepare('SELECT * FROM sponsors WHERE id = ?').get(req.params.id);
    if (!sponsor) return res.status(404).json({ error: 'Sponsor not found.' });

    db.prepare('DELETE FROM sponsors WHERE id = ?').run(sponsor.id);
    logAudit({ adminId: req.user.id, action: 'sponsor_deleted', target: sponsor.id, previousValue: { name: sponsor.name } });
    res.json({ ok: true });
});

module.exports = { router };
