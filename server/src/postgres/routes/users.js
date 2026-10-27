const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, transaction, uuid } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { getCountry, isValidNationalPhone, normalizeNationalPhone, COUNTRY_CODES } = require('../../utils/countries');

const router = express.Router();
const allowedStatuses = ['Active', 'Suspended', 'Blocked'];

function toPublicUser(user) {
    const country = getCountry(user.country_code) || getCountry('RW');
    return {
        id: user.id,
        fullName: user.full_name,
        phoneNumber: user.phone_number,
        role: user.role,
        country: { code: country.code, name: country.name, currency: country.currency, flag: country.flag, timeZone: country.timeZone },
        countryCode: country.code,
        currency: country.currency,
        referralCode: user.referral_code,
        referredBy: user.referred_by,
        balance: Number(user.balance || 0),
        pointsBalance: Number(user.points_balance || 0),
        status: user.status,
        language: user.language || 'en',
        appearance: user.appearance || 'system',
        mustResetPassword: Boolean(user.must_reset_password),
        createdAt: user.created_at,
        promoterId: user.promoter_id || null,
        promoterComment: user.promoter_comment || '',
        promoterAssignedAt: user.promoter_assigned_at || null,
        wallet: {
            deposited: Number(user.deposited_balance || 0),
            bonus: Number(user.bonus_balance || 0),
            commission: Number(user.commission_balance || 0),
            dailyIncome: Number(user.daily_income_balance || 0),
            task: Number(user.task_balance || 0),
        },
        bonus: null,
    };
}

function activityWhere(activity, userAlias = 'u', presenceAlias = 'p', params = []) {
    const now = 'CURRENT_TIMESTAMP';
    if (activity === 'live') return [`${userAlias}.status = 'Active' AND ${presenceAlias}.last_seen_at >= ${now} - INTERVAL '20 seconds'`, params];
    if (activity === 'recent') {
        return [`((${presenceAlias}.last_seen_at >= ${now} - INTERVAL '1 day' AND ${presenceAlias}.last_seen_at < ${now} - INTERVAL '20 seconds')
            OR (${presenceAlias}.last_seen_at IS NULL AND ${userAlias}.last_login_at >= ${now} - INTERVAL '1 day'))`, params];
    }
    if (activity === 'offline') {
        return [`(${presenceAlias}.last_seen_at IS NULL OR ${presenceAlias}.last_seen_at < ${now} - INTERVAL '1 day')
            AND (${userAlias}.last_login_at IS NULL OR ${userAlias}.last_login_at < ${now} - INTERVAL '1 day')`, params];
    }
    return ['', params];
}

function maskPhone(phone) {
    const value = String(phone || '');
    return value.length > 4 ? `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : '****';
}

function historyStatus(status) {
    return String(status || 'completed').replace(/^./, (letter) => letter.toUpperCase());
}

function historyItem(row, values) {
    return { id: row.id, createdAt: row.created_at, ...values };
}

router.get('/directory', requireAdmin, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim().slice(0, 100);
        const status = String(req.query.status || '').trim();
        const role = String(req.query.role || '').trim().toLowerCase();
        const type = String(req.query.type || '').trim().toLowerCase();
        const countryCode = String(req.query.country || '').trim().toUpperCase();
        const activity = String(req.query.activity || '').trim().toLowerCase();
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
        if (status && !allowedStatuses.includes(status)) return res.status(400).json({ error: 'Unsupported account status.' });
        if (role && !['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Unsupported account role.' });
        if (type && !['regular', 'promoter', 'admin'].includes(type)) return res.status(400).json({ error: 'Unsupported account type.' });
        if (countryCode && !COUNTRY_CODES.includes(countryCode)) return res.status(400).json({ error: 'Unsupported country code.' });
        if (activity && !['live', 'recent', 'offline'].includes(activity)) return res.status(400).json({ error: 'Unsupported activity filter.' });
        const conditions = [];
        const params = [];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        if (search) {
            const term = add(`%${search}%`);
            conditions.push(`(u.full_name ILIKE ${term} OR u.phone_number ILIKE ${term} OR u.referral_code ILIKE ${term})`);
        }
        if (status) conditions.push(`u.status = ${add(status)}`);
        if (role) conditions.push(`u.role = ${add(role)}`);
        if (type === 'regular') conditions.push("u.promoter_id IS NULL AND u.role = 'user'");
        if (type === 'promoter') conditions.push("u.promoter_id IS NOT NULL AND u.role = 'user'");
        if (type === 'admin') conditions.push("u.role = 'admin'");
        if (countryCode) conditions.push(`u.country_code = ${add(countryCode)}`);
        if (activity) conditions.push(activityWhere(activity)[0]);
        const clause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const count = await pool.query(
            `SELECT COUNT(*)::int AS total FROM users u LEFT JOIN user_presence p ON p.user_id = u.id ${clause}`,
            [...params],
        );
        const limitParam = add(limit);
        const offsetParam = add((page - 1) * limit);
        const { rows } = await pool.query(`
            SELECT u.id, u.full_name, u.phone_number, u.country_code, u.role, u.status, u.balance,
                   u.referral_code, u.promoter_id, u.last_login_at, u.created_at,
                   p.current_page, p.last_seen_at,
                   (u.status = 'Active' AND p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '20 seconds') AS is_live,
                   (SELECT COUNT(*) FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed')::int AS product_purchases,
                   (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved') AS deposits,
                   (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('approved', 'paid')) AS withdrawals,
                   (SELECT COUNT(*) FROM users referrals WHERE referrals.referred_by = u.id)::int AS referral_count
            FROM users u LEFT JOIN user_presence p ON p.user_id = u.id
            ${clause}
            ORDER BY u.created_at DESC, u.id
            LIMIT ${limitParam} OFFSET ${offsetParam}
        `, params);
        const users = rows.map((user) => {
            const country = getCountry(user.country_code);
            const live = Boolean(user.is_live);
            const lastActiveAt = user.last_seen_at || user.last_login_at || null;
            const recent = lastActiveAt && new Date(lastActiveAt).getTime() >= Date.now() - 86400000;
            return {
                id: user.id,
                fullName: user.full_name,
                phoneNumber: user.phone_number,
                country: country?.name || user.country_code,
                countryCode: user.country_code,
                currency: country?.currency || 'RWF',
                role: user.role,
                type: user.role === 'admin' ? 'Admin' : user.promoter_id ? 'Promoter' : 'Regular',
                status: user.status,
                balance: Number(user.balance || 0),
                referralCode: user.referral_code || '',
                promoterId: user.promoter_id || null,
                productPurchases: Number(user.product_purchases || 0),
                deposits: Number(user.deposits || 0),
                withdrawals: Number(user.withdrawals || 0),
                referrals: Number(user.referral_count || 0),
                currentPage: live ? user.current_page : null,
                isLive: live,
                activityStatus: live ? 'Live' : recent ? 'Recently active' : 'Offline',
                lastActiveAt,
                createdAt: user.created_at,
            };
        });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ users, total: Number(count.rows[0].total), page, limit, totalPages: Math.ceil(Number(count.rows[0].total) / limit) });
    } catch (error) { return next(error); }
});

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim();
        const values = search ? [`%${search}%`] : [];
        const { rows } = await pool.query(`
            SELECT * FROM users
            WHERE role = 'user' AND promoter_id IS NULL
              ${search ? 'AND (full_name ILIKE $1 OR phone_number ILIKE $1 OR id ILIKE $1 OR referral_code ILIKE $1)' : ''}
            ORDER BY created_at DESC
        `, values);
        return res.json({ users: rows.map(toPublicUser) });
    } catch (error) { return next(error); }
});

router.get('/active', requireAdmin, async (req, res, next) => {
    try {
        const search = String(req.query.search || '').trim();
        const requestedStatus = String(req.query.status || '').trim();
        const requestedRole = String(req.query.role || '').trim().toLowerCase();
        const activity = String(req.query.activity || 'all').trim().toLowerCase();
        if (requestedStatus && !allowedStatuses.includes(requestedStatus)) return res.status(400).json({ error: 'Unsupported account status.' });
        if (requestedRole && !['user', 'admin'].includes(requestedRole)) return res.status(400).json({ error: 'Unsupported account role.' });
        if (!['all', 'live', 'recent', 'offline'].includes(activity)) return res.status(400).json({ error: 'Unsupported activity filter.' });
        const conditions = ["EXISTS (SELECT 1 FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed')"];
        const params = [];
        const add = (value) => { params.push(value); return `$${params.length}`; };
        if (requestedStatus) conditions.push(`u.status = ${add(requestedStatus)}`);
        if (requestedRole) conditions.push(`u.role = ${add(requestedRole)}`);
        if (search) {
            const term = add(`%${search}%`);
            conditions.push(`(u.full_name ILIKE ${term} OR u.phone_number ILIKE ${term})`);
        }
        if (activity !== 'all') conditions.push(activityWhere(activity)[0]);
        const { rows } = await pool.query(`
            SELECT u.id, u.full_name, u.phone_number, u.country_code, u.role, u.status,
                   u.balance, u.last_login_at, u.created_at, u.promoter_id, p.current_page, p.last_seen_at,
                   (u.status = 'Active' AND p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '20 seconds') AS is_live,
                   (p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '1 day'
                    AND p.last_seen_at < CURRENT_TIMESTAMP - INTERVAL '20 seconds')
                    OR (p.last_seen_at IS NULL AND u.last_login_at >= CURRENT_TIMESTAMP - INTERVAL '1 day') AS is_recent,
                   (SELECT COUNT(*) FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed')::int AS product_purchases,
                   (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved') AS deposits,
                   (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('approved', 'paid')) AS withdrawals,
                   ref.full_name AS referrer_name
            FROM users u
            LEFT JOIN user_presence p ON p.user_id = u.id
            LEFT JOIN users ref ON ref.id = u.referred_by
            WHERE ${conditions.join(' AND ')}
            ORDER BY COALESCE(p.last_seen_at, u.last_login_at, u.created_at) DESC
            LIMIT 200
        `, params);
        const users = rows.map((user) => {
            const country = getCountry(user.country_code);
            const live = Boolean(user.is_live);
            const recent = Boolean(user.is_recent);
            return {
                id: user.id, fullName: user.full_name, phoneNumber: user.phone_number,
                country: country?.name || user.country_code, currency: country?.currency || 'RWF',
                role: user.role, status: user.status, balance: Number(user.balance || 0),
                deposits: Number(user.deposits || 0), withdrawals: Number(user.withdrawals || 0),
                productPurchases: Number(user.product_purchases || 0), promoterId: user.promoter_id || null,
                referrerName: user.referrer_name || '', currentPage: live ? user.current_page : null,
                isLive: live, activityStatus: live ? 'Live' : recent ? 'Recently active' : 'Offline',
                lastActiveAt: user.last_seen_at || user.last_login_at || user.created_at,
            };
        });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ users, total: users.length });
    } catch (error) { return next(error); }
});

router.get('/history', requireAuth, async (req, res, next) => {
    try {
        const category = String(req.query.category || 'all').toLowerCase();
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        if (!new Set(['all', 'deposits', 'withdrawals', 'rewards', 'tasks']).has(category)) return res.status(400).json({ error: 'Invalid history category.' });
        const id = req.user.id;
        const currency = getCountry(req.user.country_code)?.currency || 'RWF';
        const items = [];
        const addRows = async (sql, params, convert) => {
            const { rows } = await pool.query(sql, params);
            for (const row of rows) {
                const item = convert(row);
                if (item) items.push(item);
            }
        };
        const queries = [];
        if (category === 'all' || category === 'deposits') queries.push(addRows(
            'SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC',
            [id],
            (row) => historyItem(row, {
                category: 'deposits', type: 'Deposit', description: `${row.method.toUpperCase()} Mobile Money`,
                amount: row.amount, unit: currency, direction: 'credit', status: historyStatus(row.status), referenceId: row.id,
            }),
        ));
        if (category === 'all' || category === 'withdrawals') queries.push(addRows(
            'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
            [id],
            (row) => historyItem(row, {
                category: 'withdrawals', type: 'Withdrawal',
                description: row.method === 'bank'
                    ? `${row.method.toUpperCase()} · ${row.bank_name || 'Bank account'} · ${String(row.bank_account_number || '').replace(/.(?=.{4})/g, '•')}`
                    : `${row.method.toUpperCase()} Mobile Money · ${maskPhone(row.mobile_money_number)}`,
                amount: row.amount, unit: currency, direction: 'debit', status: historyStatus(row.status),
                referenceId: row.id, fee: row.fee, receivedAmount: row.received_amount,
            }),
        ));
        if (category === 'tasks') {
            queries.push(addRows(
                'SELECT * FROM chakin_checkins WHERE user_id = $1 ORDER BY created_at DESC',
                [id],
                (row) => historyItem(row, {
                    category: 'tasks', type: 'Chakin', description: 'Daily Check-in', amount: row.reward_amount,
                    unit: currency, direction: 'credit', status: historyStatus(row.status), referenceId: row.reference_id,
                }),
            ));
            queries.push(addRows(
                `SELECT r.*, g.code, g.reward FROM gift_code_redemptions r
                 JOIN gift_codes g ON g.id = r.gift_code_id WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
                [id],
                (row) => historyItem(row, {
                    category: 'tasks', type: 'Gift Code', description: `Gift code ${row.code}`,
                    amount: row.reward, unit: currency, direction: 'credit', status: 'Completed', referenceId: row.id,
                }),
            ));
            queries.push(addRows(
                'SELECT * FROM spin_results WHERE user_id = $1 ORDER BY created_at DESC',
                [id],
                (row) => historyItem(row, {
                    category: 'tasks', type: 'Spin & Win', description: row.prize_label || 'Spin result',
                    amount: row.amount, unit: 'POINTS', direction: 'credit', status: historyStatus(row.status),
                    referenceId: row.reference_id || row.id,
                }),
            ));
        }
        if (['all', 'rewards', 'tasks'].includes(category)) queries.push(addRows(
            'SELECT * FROM reward_transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [id],
            (row) => {
                const sourceLabels = { chakin: 'Chakin Reward', gift_code: 'Gift Code Reward', spin: 'Spin & Win Reward', invite: 'Invite Reward', commission: 'Commission' };
                const item = historyItem(row, {
                    category: 'rewards', type: sourceLabels[row.type] || 'Reward', description: row.source,
                    amount: row.amount, unit: row.unit, direction: 'credit', status: historyStatus(row.status), referenceId: row.reference_id,
                });
                if (category === 'tasks' && ['chakin', 'gift_code', 'spin'].includes(row.type)) item.category = 'tasks';
                else if (category === 'tasks') return null;
                return item;
            },
        ));
        if (category === 'all') queries.push(addRows(
            "SELECT * FROM transactions WHERE user_id = $1 AND type = 'adjustment' ORDER BY created_at DESC",
            [id],
            (row) => historyItem(row, {
                category: 'all', type: 'Balance Adjustment', description: row.reason || 'Account balance adjustment',
                amount: Math.abs(row.amount), unit: currency, direction: row.amount >= 0 ? 'credit' : 'debit',
                status: 'Completed', referenceId: row.reference_id || row.id,
            }),
        ));
        await Promise.all(queries);
        const timestamp = (value) => new Date(value).getTime() || 0;
        items.sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
        const offset = (page - 1) * limit;
        return res.json({
            items: items.slice(offset, offset + limit),
            pagination: { page, limit, hasMore: offset + limit < items.length },
        });
    } catch (error) { return next(error); }
});

router.get('/:id', requireAdmin, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        const user = rows[0];
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const [deposits, withdrawals, transactions, products, referrals, taskClaims] = await Promise.all([
            pool.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC', [user.id]),
            pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [user.id]),
            pool.query('SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC', [user.id]),
            pool.query(`
                SELECT pp.id, pp.product_id, pp.price, pp.status, pp.created_at, p.name
                FROM product_purchases pp LEFT JOIN products p ON p.id = pp.product_id
                WHERE pp.user_id = $1 ORDER BY pp.created_at DESC
            `, [user.id]),
            pool.query('SELECT * FROM users WHERE referred_by = $1', [user.id]),
            pool.query('SELECT * FROM task_claims WHERE user_id = $1 ORDER BY created_at DESC', [user.id]),
        ]);
        return res.json({
            user: toPublicUser(user),
            financial: { deposits: deposits.rows, withdrawals: withdrawals.rows, transactions: transactions.rows },
            products: products.rows,
            team: { referrals: referrals.rows.map(toPublicUser), referredBy: user.referred_by },
            tasks: taskClaims.rows,
        });
    } catch (error) { return next(error); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            if (user.role !== 'user') return { status: 403, error: 'Admin accounts cannot be edited here.' };
            const fullName = String(req.body?.fullName || '').trim();
            const phoneNumber = String(req.body?.phoneNumber || '').trim();
            if (!fullName || fullName.length > 100) return { status: 400, error: 'Full name is required and must be no more than 100 characters.' };
            if (!isValidNationalPhone(user.country_code, phoneNumber)) return { status: 400, error: 'Enter a valid phone number for this user country.' };
            const normalizedPhoneNumber = normalizeNationalPhone(user.country_code, phoneNumber);
            const conflict = await client.query('SELECT id FROM users WHERE phone_number = $1 AND id <> $2', [normalizedPhoneNumber, user.id]);
            if (conflict.rowCount) return { status: 409, error: 'This phone number is already used by another account.' };
            await client.query('UPDATE users SET full_name = $1, phone_number = $2 WHERE id = $3', [fullName, normalizedPhoneNumber, user.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'user_profile_updated',
                target: user.id,
                previousValue: { fullName: user.full_name, phoneNumber: user.phone_number },
                newValue: { fullName, phoneNumber: normalizedPhoneNumber },
            });
            const updated = await client.query('SELECT * FROM users WHERE id = $1', [user.id]);
            return { user: toPublicUser(updated.rows[0]) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ user: result.user });
    } catch (error) { return next(error); }
});

router.post('/:id/role', requireAdmin, async (req, res, next) => {
    try {
        const role = String(req.body?.role || '').trim().toLowerCase();
        if (role !== 'admin') return res.status(400).json({ error: 'Only the admin role can be granted here.' });
        if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            if (user.role === 'admin') return { status: 409, error: 'This user is already an admin.' };
            if (user.role !== 'user') return { status: 400, error: 'Only regular user accounts can be granted admin access.' };
            await client.query("UPDATE users SET role = 'admin', auth_version = auth_version + 1 WHERE id = $1", [user.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'user_admin_access_granted',
                target: user.id,
                previousValue: { role: user.role },
                newValue: { role: 'admin' },
            });
            const updated = await client.query('SELECT * FROM users WHERE id = $1', [user.id]);
            return { user: toPublicUser(updated.rows[0]) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ user: result.user });
    } catch (error) { return next(error); }
});

router.post('/bulk-status', requireAdmin, async (req, res, next) => {
    try {
        const { status, reason } = req.body || {};
        if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Status must be Active, Suspended or Blocked.' });
        const result = await transaction(async (client) => {
            const { rows } = await client.query("SELECT * FROM users WHERE role = 'user' FOR UPDATE");
            const updatedIds = [];
            for (const user of rows) {
                if (user.status === status) continue;
                await client.query('UPDATE users SET status = $1, auth_version = auth_version + 1 WHERE id = $2', [status, user.id]);
                updatedIds.push(user.id);
                await logAudit(client, {
                    adminId: req.user.id,
                    action: status === 'Active' ? 'user_unblocked' : status === 'Suspended' ? 'user_suspended' : 'user_blocked',
                    target: user.id,
                    previousValue: user.status,
                    newValue: status,
                    reason: reason || 'Bulk status update',
                });
            }
            return updatedIds;
        });
        return res.json({ updated: result.length, status, ids: result });
    } catch (error) { return next(error); }
});

router.post('/:id/status', requireAdmin, async (req, res, next) => {
    try {
        const { status, reason } = req.body || {};
        if (!allowedStatuses.includes(status)) return res.status(400).json({ error: 'Status must be Active, Suspended or Blocked.' });
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            await client.query('UPDATE users SET status = $1, auth_version = auth_version + 1 WHERE id = $2', [status, user.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: status === 'Active' ? 'user_unblocked' : status === 'Suspended' ? 'user_suspended' : 'user_blocked',
                target: user.id,
                previousValue: user.status,
                newValue: status,
                reason,
            });
            const updated = await client.query('SELECT * FROM users WHERE id = $1', [user.id]);
            return { user: toPublicUser(updated.rows[0]) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ user: result.user });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            if (user.role === 'admin') return { status: 403, error: 'Admin accounts cannot be deleted here.' };
            await logAudit(client, { adminId: req.user.id, action: 'user_deleted', target: user.id, previousValue: toPublicUser(user) });
            await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [user.id]);
            for (const table of [
                'transactions', 'deposits', 'withdrawals', 'task_claims', 'gift_code_redemptions',
                'spin_results', 'reward_transactions', 'password_reset_tokens', 'chakin_checkins',
                'promoter_comments', 'product_purchases', 'product_earning_ledger', 'user_bonuses', 'user_presence',
            ]) {
                await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [user.id]);
            }
            await client.query("DELETE FROM users WHERE id = $1 AND role = 'user'", [user.id]);
            return { id: user.id };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ deleted: true, id: result.id });
    } catch (error) { return next(error); }
});

router.post('/:id/reset-password', requireAdmin, async (req, res, next) => {
    try {
        const temporaryPassword = crypto.randomBytes(9).toString('base64url');
        const passwordHash = bcrypt.hashSync(temporaryPassword, 10);
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            if (!rows[0]) return { status: 404, error: 'User not found.' };
            await client.query('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND used_at IS NULL', [req.params.id]);
            await client.query(
                'UPDATE users SET password_hash = $1, must_reset_password = 1, auth_version = auth_version + 1 WHERE id = $2',
                [passwordHash, req.params.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'password_reset_completed',
                target: req.params.id,
                reason: 'Temporary password assigned by Admin',
            });
            return true;
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ temporaryPassword, mustResetPassword: true });
    } catch (error) { return next(error); }
});

router.post('/:id/adjust-balance', requireAdmin, async (req, res, next) => {
    try {
        const { amount, direction, reason } = req.body || {};
        const numericAmount = Math.round(Number(amount));
        if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0 || numericAmount > 2147483647 ||
            !['add', 'remove'].includes(direction) || !reason) {
            return res.status(400).json({ error: 'Amount (> 0), direction (add/remove) and reason are required.' });
        }
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            const previousBalance = Number(user.balance);
            const delta = direction === 'add' ? numericAmount : -numericAmount;
            const newBalance = previousBalance + delta;
            if (newBalance < 0 || newBalance > 2147483647) return { status: 400, error: 'Adjustment would put the balance outside the supported range.' };
            const txId = uuid();
            await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'adjustment', $3, $4, $5, $6, $7, $8)`,
                [txId, user.id, delta, previousBalance, newBalance, reason, txId, req.user.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: direction === 'add' ? 'balance_increased' : 'balance_decreased',
                target: user.id,
                previousValue: previousBalance,
                newValue: newBalance,
                reason,
            });
            return { transactionId: txId, previousBalance, newBalance };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (error) { return next(error); }
});

module.exports = { router, toPublicUser };
