// Read-only audit log viewer for the admin panel.
const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
    const search = String(req.query.search || '').trim();
    const action = String(req.query.action || '').trim();
    const status = String(req.query.status || '').trim().toLowerCase();
    const date = String(req.query.date || '').trim();
    const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
    const where = [];
    const params = [];
    if (search) {
        where.push('(a.action LIKE ? OR a.target LIKE ? OR admin.phone_number LIKE ? OR admin.full_name LIKE ? OR target_user.phone_number LIKE ? OR target_user.full_name LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like, like, like, like);
    }
    if (action) { where.push('a.action = ?'); params.push(action); }
    if (status) { where.push('LOWER(a.status) = ?'); params.push(status); }
    if (date) { where.push('date(a.created_at) = ?'); params.push(date); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs a LEFT JOIN users admin ON admin.id = a.admin_id LEFT JOIN users target_user ON target_user.id = a.target ${clause}`).get(...params).count;
    const rows = db.prepare(`
        SELECT a.*, admin.full_name AS admin_name, admin.phone_number AS admin_phone,
               target_user.full_name AS target_user_name, target_user.phone_number AS target_user_phone
        FROM audit_logs a
        LEFT JOIN users admin ON admin.id = a.admin_id
        LEFT JOIN users target_user ON target_user.id = a.target
        ${clause}
        ORDER BY a.created_at ${sort}
        LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);
    const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC').all().map((row) => row.action);
    res.json({ logs: rows, actions, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
});

module.exports = { router };
