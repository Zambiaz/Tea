const express = require('express');
const { pool } = require('../store');
const { requireAdmin } = require('../middleware');

const router = express.Router();

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(10, Number.parseInt(req.query.limit, 10) || 25));
        const search = String(req.query.search || '').trim();
        const action = String(req.query.action || '').trim();
        const status = String(req.query.status || '').trim().toLowerCase();
        const date = String(req.query.date || '').trim();
        const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
        const where = [];
        const params = [];
        const add = (value) => {
            params.push(value);
            return `$${params.length}`;
        };
        if (search) {
            const term = add(`%${search}%`);
            where.push(`(a.action ILIKE ${term} OR a.target ILIKE ${term} OR admin.phone_number ILIKE ${term}
                OR admin.full_name ILIKE ${term} OR target_user.phone_number ILIKE ${term}
                OR target_user.full_name ILIKE ${term})`);
        }
        if (action) where.push(`a.action = ${add(action)}`);
        if (status) where.push(`LOWER(a.status) = ${add(status)}`);
        if (date) where.push(`a.created_at::date::text = ${add(date)}`);
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const totalResult = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM audit_logs a
             LEFT JOIN users admin ON admin.id = a.admin_id
             LEFT JOIN users target_user ON target_user.id = a.target
             ${clause}`,
            [...params],
        );
        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(`
            SELECT a.*, admin.full_name AS admin_name, admin.phone_number AS admin_phone,
                   target_user.full_name AS target_user_name, target_user.phone_number AS target_user_phone
            FROM audit_logs a
            LEFT JOIN users admin ON admin.id = a.admin_id
            LEFT JOIN users target_user ON target_user.id = a.target
            ${clause}
            ORDER BY a.created_at ${sort}
            LIMIT ${limitParam} OFFSET ${offsetParam}
        `, params);
        const { rows: actionRows } = await pool.query('SELECT DISTINCT action FROM audit_logs ORDER BY action ASC');
        const total = Number(totalResult.rows[0].count);
        return res.json({
            logs: rows,
            actions: actionRows.map((row) => row.action),
            pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
        });
    } catch (error) { return next(error); }
});

module.exports = { router };
