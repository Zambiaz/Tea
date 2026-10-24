// Admin-facing user management: search/list, detail view, block/unblock, password reset,
// and audited balance adjustments. All of this requires a valid admin session (requireAdmin).
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { toPublicUser } = require('./auth');
const { COUNTRY_CODES, getCountry, isValidNationalPhone, normalizeNationalPhone } = require('../utils/countries');

const router = express.Router();

router.get('/directory', requireAdmin, (req, res) => {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const status = String(req.query.status || '').trim();
    const role = String(req.query.role || '').trim().toLowerCase();
    const type = String(req.query.type || '').trim().toLowerCase();
    const countryCode = String(req.query.country || '').trim().toUpperCase();
    const activity = String(req.query.activity || '').trim().toLowerCase();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));

    if (status && !['Active', 'Suspended', 'Blocked'].includes(status)) return res.status(400).json({ error: 'Unsupported account status.' });
    if (role && !['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Unsupported account role.' });
    if (type && !['regular', 'promoter', 'admin'].includes(type)) return res.status(400).json({ error: 'Unsupported account type.' });
    if (countryCode && !COUNTRY_CODES.includes(countryCode)) return res.status(400).json({ error: 'Unsupported country code.' });
    if (activity && !['live', 'recent', 'offline'].includes(activity)) return res.status(400).json({ error: 'Unsupported activity filter.' });

    const conditions = [];
    const params = [];
    if (search) {
        conditions.push('(u.full_name LIKE ? OR u.phone_number LIKE ? OR u.referral_code LIKE ?)');
        const like = `%${search}%`;
        params.push(like, like, like);
    }
    if (status) {
        conditions.push('u.status = ?');
        params.push(status);
    }
    if (role) {
        conditions.push('u.role = ?');
        params.push(role);
    }
    if (type === 'regular') conditions.push("u.promoter_id IS NULL AND u.role = 'user'");
    if (type === 'promoter') conditions.push("u.promoter_id IS NOT NULL AND u.role = 'user'");
    if (type === 'admin') conditions.push("u.role = 'admin'");
    if (countryCode) {
        conditions.push('u.country_code = ?');
        params.push(countryCode);
    }
    if (activity === 'live') conditions.push("u.status = 'Active' AND p.last_seen_at >= datetime('now', '-20 seconds')");
    if (activity === 'recent') {
        conditions.push("((p.last_seen_at >= datetime('now', '-1 day') AND p.last_seen_at < datetime('now', '-20 seconds')) OR (p.last_seen_at IS NULL AND u.last_login_at >= datetime('now', '-1 day')))");
    }
    if (activity === 'offline') {
        conditions.push("(p.last_seen_at IS NULL OR p.last_seen_at < datetime('now', '-1 day')) AND (u.last_login_at IS NULL OR u.last_login_at < datetime('now', '-1 day'))");
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = db.prepare(`
        SELECT COUNT(*) AS total
        FROM users u
        LEFT JOIN user_presence p ON p.user_id = u.id
        ${where}
    `).get(...params).total;
    const users = db.prepare(`
        SELECT u.id, u.full_name, u.phone_number, u.country_code, u.role, u.status, u.balance,
            u.referral_code, u.promoter_id, u.last_login_at, u.created_at,
            p.current_page, p.last_seen_at,
            CASE WHEN u.status = 'Active' AND p.last_seen_at >= datetime('now', '-20 seconds') THEN 1 ELSE 0 END AS is_live,
            (SELECT COUNT(*) FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed') AS product_purchases,
            (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved') AS deposits,
            (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('approved', 'paid')) AS withdrawals,
            (SELECT COUNT(*) FROM users referrals WHERE referrals.referred_by = u.id) AS referral_count
        FROM users u
        LEFT JOIN user_presence p ON p.user_id = u.id
        ${where}
        ORDER BY u.created_at DESC, u.id
        LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit).map((user) => {
        const country = getCountry(user.country_code);
        const live = Boolean(user.is_live);
        const lastActiveAt = user.last_seen_at || user.last_login_at || null;
        const recent = lastActiveAt && Date.parse(String(lastActiveAt).replace(' ', 'T') + (String(lastActiveAt).includes('Z') ? '' : 'Z')) >= Date.now() - 86400000;
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
    res.json({ users, total: Number(total), page, limit, totalPages: Math.ceil(Number(total) / limit) });
});

router.get('/', requireAdmin, (req, res) => {
    const { search = '' } = req.query;
    let rows;
    if (search.trim()) {
        const like = `%${search.trim()}%`;
        rows = db.prepare(
            `SELECT * FROM users WHERE role = 'user' AND promoter_id IS NULL AND (full_name LIKE ? OR phone_number LIKE ? OR id LIKE ? OR referral_code LIKE ?) ORDER BY created_at DESC`,
        ).all(like, like, like, like);
    } else {
        rows = db.prepare(`SELECT * FROM users WHERE role = 'user' AND promoter_id IS NULL ORDER BY created_at DESC`).all();
    }
    res.json({ users: rows.map(toPublicUser) });
});

router.get('/active', requireAdmin, (req, res) => {
    const search = String(req.query.search || '').trim();
    const requestedStatus = String(req.query.status || '').trim();
    const requestedRole = String(req.query.role || '').trim().toLowerCase();
    const activity = String(req.query.activity || 'all').trim().toLowerCase();
    if (requestedStatus && !['Active', 'Suspended', 'Blocked'].includes(requestedStatus)) {
        return res.status(400).json({ error: 'Unsupported account status.' });
    }
    if (requestedRole && !['user', 'admin'].includes(requestedRole)) {
        return res.status(400).json({ error: 'Unsupported account role.' });
    }
    if (!['all', 'live', 'recent', 'offline'].includes(activity)) {
        return res.status(400).json({ error: 'Unsupported activity filter.' });
    }

    const conditions = ["EXISTS (SELECT 1 FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed')"];
    const params = [];
    if (requestedStatus) {
        conditions.push('u.status = ?');
        params.push(requestedStatus);
    }
    if (requestedRole) {
        conditions.push('u.role = ?');
        params.push(requestedRole);
    }
    if (search) {
        conditions.push('(u.full_name LIKE ? OR u.phone_number LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
    }
    if (activity === 'live') conditions.push("u.status = 'Active' AND p.last_seen_at >= datetime('now', '-20 seconds')");
    if (activity === 'recent') conditions.push("((p.last_seen_at >= datetime('now', '-1 day') AND p.last_seen_at < datetime('now', '-20 seconds')) OR (p.last_seen_at IS NULL AND u.last_login_at >= datetime('now', '-1 day')))");
    if (activity === 'offline') conditions.push("(p.last_seen_at IS NULL OR p.last_seen_at < datetime('now', '-1 day')) AND (u.last_login_at IS NULL OR u.last_login_at < datetime('now', '-1 day'))");

    const users = db.prepare(`
        SELECT u.id, u.full_name, u.phone_number, u.country_code, u.role, u.status,
            u.balance, u.last_login_at, u.created_at, u.promoter_id,
            p.current_page, p.last_seen_at,
            CASE WHEN u.status = 'Active' AND p.last_seen_at >= datetime('now', '-20 seconds') THEN 1 ELSE 0 END AS is_live,
            CASE WHEN (p.last_seen_at >= datetime('now', '-1 day') AND p.last_seen_at < datetime('now', '-20 seconds'))
                OR (p.last_seen_at IS NULL AND u.last_login_at >= datetime('now', '-1 day')) THEN 1 ELSE 0 END AS is_recent,
            (SELECT COUNT(*) FROM product_purchases pp WHERE pp.user_id = u.id AND pp.status = 'completed') AS product_purchases,
            (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d WHERE d.user_id = u.id AND d.status = 'approved') AS deposits,
            (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w WHERE w.user_id = u.id AND w.status IN ('approved', 'paid')) AS withdrawals,
            ref.full_name AS referrer_name
        FROM users u
        LEFT JOIN user_presence p ON p.user_id = u.id
        LEFT JOIN users ref ON ref.id = u.referred_by
        WHERE ${conditions.join(' AND ')}
        ORDER BY COALESCE(p.last_seen_at, u.last_login_at, u.created_at) DESC
        LIMIT 200
    `).all(...params).map((user) => {
        const country = getCountry(user.country_code);
        const isLive = Boolean(user.is_live);
        const isRecentlyActive = Boolean(user.is_recent);
        return {
            id: user.id,
            fullName: user.full_name,
            phoneNumber: user.phone_number,
            country: country?.name || user.country_code,
            currency: country?.currency || 'RWF',
            role: user.role,
            status: user.status,
            balance: Number(user.balance || 0),
            deposits: Number(user.deposits || 0),
            withdrawals: Number(user.withdrawals || 0),
            productPurchases: Number(user.product_purchases || 0),
            promoterId: user.promoter_id || null,
            referrerName: user.referrer_name || '',
            currentPage: isLive ? user.current_page : null,
            isLive,
            activityStatus: isLive ? 'Live' : isRecentlyActive ? 'Recently active' : 'Offline',
            lastActiveAt: user.last_seen_at || user.last_login_at || user.created_at,
        };
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ users, total: users.length });
});

function maskPhone(phone) {
    const value = String(phone || '');
    return value.length > 4 ? `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : '****';
}

function historyStatus(status) {
    return String(status || 'completed').replace(/^./, (letter) => letter.toUpperCase());
}

router.get('/history', requireAuth, (req, res) => {
    const category = String(req.query.category || 'all').toLowerCase();
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const allowedCategories = new Set(['all', 'deposits', 'withdrawals', 'rewards', 'tasks']);
    if (!allowedCategories.has(category)) return res.status(400).json({ error: 'Invalid history category.' });

    const items = [];
    const userId = req.user.id;
    const currency = getCountry(req.user.country_code)?.currency || 'RWF';

    if (category === 'all' || category === 'deposits') {
        db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(userId).forEach((row) => {
            items.push({
                id: row.id, category: 'deposits', type: 'Deposit', description: `${row.method.toUpperCase()} Mobile Money`,
                amount: row.amount, unit: currency, direction: 'credit', status: historyStatus(row.status),
                createdAt: row.created_at, referenceId: row.id,
            });
        });
    }

    if (category === 'all' || category === 'withdrawals') {
        db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(userId).forEach((row) => {
            items.push({
                id: row.id, category: 'withdrawals', type: 'Withdrawal', description: row.method === 'bank'
                    ? `${row.method.toUpperCase()} · ${row.bank_name || 'Bank account'} · ${String(row.bank_account_number || '').replace(/.(?=.{4})/g, '•')}`
                    : `${row.method.toUpperCase()} Mobile Money · ${maskPhone(row.mobile_money_number)}`,
                amount: row.amount, unit: currency, direction: 'debit', status: historyStatus(row.status),
                createdAt: row.created_at, referenceId: row.id, fee: row.fee, receivedAmount: row.received_amount,
            });
        });
    }

    if (category === 'all' || category === 'rewards' || category === 'tasks') {
        if (category === 'tasks') {
            db.prepare('SELECT * FROM chakin_checkins WHERE user_id = ? ORDER BY created_at DESC').all(userId).forEach((row) => {
                items.push({
                    id: row.id, category: 'tasks', type: 'Chakin', description: 'Daily Check-in',
                    amount: row.reward_amount, unit: currency, direction: 'credit', status: historyStatus(row.status),
                    createdAt: row.created_at, referenceId: row.reference_id,
                });
            });
            db.prepare(
                `SELECT r.*, g.code, g.reward FROM gift_code_redemptions r JOIN gift_codes g ON g.id = r.gift_code_id WHERE r.user_id = ? ORDER BY r.created_at DESC`,
            ).all(userId).forEach((row) => {
                items.push({
                    id: row.id, category: 'tasks', type: 'Gift Code', description: `Gift code ${row.code}`,
                    amount: row.reward, unit: currency, direction: 'credit', status: 'Completed',
                    createdAt: row.created_at, referenceId: row.id,
                });
            });
            db.prepare('SELECT * FROM spin_results WHERE user_id = ? ORDER BY created_at DESC').all(userId).forEach((row) => {
                items.push({
                    id: row.id, category: 'tasks', type: 'Spin & Win', description: row.prize_label || 'Spin result',
                    amount: row.amount, unit: 'POINTS', direction: 'credit', status: historyStatus(row.status),
                    createdAt: row.created_at, referenceId: row.reference_id || row.id,
                });
            });
        }

        db.prepare('SELECT * FROM reward_transactions WHERE user_id = ? ORDER BY created_at DESC').all(userId).forEach((row) => {
            const sourceLabels = { chakin: 'Chakin Reward', gift_code: 'Gift Code Reward', spin: 'Spin & Win Reward', invite: 'Invite Reward', commission: 'Commission' };
            const item = {
                id: row.id, category: 'rewards', type: sourceLabels[row.type] || 'Reward', description: row.source,
                amount: row.amount, unit: row.unit, direction: 'credit', status: historyStatus(row.status),
                createdAt: row.created_at, referenceId: row.reference_id,
            };
            if (category === 'all' || category === 'rewards') items.push(item);
            else if (['chakin', 'gift_code', 'spin'].includes(row.type)) items.push({ ...item, category: 'tasks' });
        });
    }

    if (category === 'all') {
        db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'adjustment' ORDER BY created_at DESC").all(userId).forEach((row) => {
            items.push({
                id: row.id, category: 'all', type: 'Balance Adjustment', description: row.reason || 'Account balance adjustment',
                amount: Math.abs(row.amount), unit: currency, direction: row.amount >= 0 ? 'credit' : 'debit', status: 'Completed',
                createdAt: row.created_at, referenceId: row.reference_id || row.id,
            });
        });
    }

    items.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    const offset = (page - 1) * limit;
    const pageItems = items.slice(offset, offset + limit);
    res.json({
        items: pageItems,
        pagination: { page, limit, hasMore: offset + limit < items.length },
    });
});

router.get('/:id', requireAdmin, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const deposits = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    const transactions = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC').all(user.id);
    const products = db.prepare(`
        SELECT pp.id, pp.product_id, pp.price, pp.status, pp.created_at, p.name
        FROM product_purchases pp
        LEFT JOIN products p ON p.id = pp.product_id
        WHERE pp.user_id = ?
        ORDER BY pp.created_at DESC
    `).all(user.id);
    const referrals = db.prepare(`SELECT * FROM users WHERE referred_by = ?`).all(user.id).map(toPublicUser);
    const taskClaims = db.prepare('SELECT * FROM task_claims WHERE user_id = ? ORDER BY created_at DESC').all(user.id);

    res.json({
        user: toPublicUser(user),
        financial: { deposits, withdrawals, transactions },
        products,
        team: { referrals, referredBy: user.referred_by },
        tasks: taskClaims,
    });
});

router.put('/:id', requireAdmin, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'user') return res.status(403).json({ error: 'Admin accounts cannot be edited here.' });

    const fullName = String(req.body?.fullName || '').trim();
    const phoneNumber = String(req.body?.phoneNumber || '').trim();
    if (!fullName || fullName.length > 100) return res.status(400).json({ error: 'Full name is required and must be no more than 100 characters.' });
    if (!isValidNationalPhone(user.country_code, phoneNumber)) return res.status(400).json({ error: 'Enter a valid phone number for this user country.' });
    const normalizedPhoneNumber = normalizeNationalPhone(user.country_code, phoneNumber);
    const existingPhone = db.prepare('SELECT id FROM users WHERE phone_number = ? AND id != ?').get(normalizedPhoneNumber, user.id);
    if (existingPhone) return res.status(409).json({ error: 'This phone number is already used by another account.' });

    db.prepare('UPDATE users SET full_name = ?, phone_number = ? WHERE id = ?').run(fullName, normalizedPhoneNumber, user.id);
    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    logAudit({
        adminId: req.user.id,
        action: 'user_profile_updated',
        target: user.id,
        previousValue: { fullName: user.full_name, phoneNumber: user.phone_number },
        newValue: { fullName, phoneNumber: normalizedPhoneNumber },
    });
    res.json({ user: toPublicUser(updated) });
});

router.post('/:id/role', requireAdmin, (req, res) => {
    const role = String(req.body?.role || '').trim().toLowerCase();
    if (role !== 'admin') return res.status(400).json({ error: 'Only the admin role can be granted here.' });
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role === 'admin') return res.status(409).json({ error: 'This user is already an admin.' });
    if (user.role !== 'user') return res.status(400).json({ error: 'Only regular user accounts can be granted admin access.' });

    let updatedUser;
    db.exec('BEGIN IMMEDIATE');
    try {
        const currentUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        if (!currentUser || currentUser.role !== 'user') {
            db.exec('ROLLBACK');
            return res.status(409).json({ error: 'This account is no longer a regular user.' });
        }
        db.prepare("UPDATE users SET role = 'admin', auth_version = auth_version + 1 WHERE id = ?").run(currentUser.id);
        updatedUser = db.prepare('SELECT * FROM users WHERE id = ?').get(currentUser.id);
        logAudit({
            adminId: req.user.id,
            action: 'user_admin_access_granted',
            target: currentUser.id,
            previousValue: { role: currentUser.role },
            newValue: { role: updatedUser.role },
        });
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        console.error('[BMG admin] Failed to grant admin access:', error);
        return res.status(500).json({ error: 'Could not grant admin access.' });
    }
    res.json({ user: toPublicUser(updatedUser) });
});

router.post('/bulk-status', requireAdmin, (req, res) => {
    const { status, reason } = req.body || {};
    if (!['Active', 'Suspended', 'Blocked'].includes(status)) {
        return res.status(400).json({ error: 'Status must be Active, Suspended or Blocked.' });
    }

    const users = db.prepare("SELECT * FROM users WHERE role = 'user'").all();
    if (!users.length) {
        return res.json({ updated: 0, status });
    }

    const updatedIds = [];
    for (const user of users) {
        if (user.status === status) continue;
        db.prepare('UPDATE users SET status = ?, auth_version = auth_version + 1 WHERE id = ?').run(status, user.id);
        updatedIds.push(user.id);
        logAudit({
            adminId: req.user.id,
            action: status === 'Active' ? 'user_unblocked' : status === 'Suspended' ? 'user_suspended' : 'user_blocked',
            target: user.id,
            previousValue: user.status,
            newValue: status,
            reason: reason || 'Bulk status update',
        });
    }

    res.json({ updated: updatedIds.length, status, ids: updatedIds });
});

router.post('/:id/status', requireAdmin, (req, res) => {
    const { status, reason } = req.body || {};
    if (!['Active', 'Suspended', 'Blocked'].includes(status)) {
        return res.status(400).json({ error: 'Status must be Active, Suspended or Blocked.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    db.prepare('UPDATE users SET status = ?, auth_version = auth_version + 1 WHERE id = ?').run(status, user.id);
    logAudit({
        adminId: req.user.id,
            action: status === 'Active' ? 'user_unblocked' : status === 'Suspended' ? 'user_suspended' : 'user_blocked',
        target: user.id,
        previousValue: user.status,
        newValue: status,
        reason,
    });

    res.json({ user: toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role === 'admin') return res.status(403).json({ error: 'Admin accounts cannot be deleted here.' });

    const deletedUser = toPublicUser(user);
    try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('UPDATE users SET referred_by = NULL WHERE referred_by = ?').run(user.id);
        [
            'transactions', 'deposits', 'withdrawals', 'task_claims', 'gift_code_redemptions',
            'spin_results', 'reward_transactions', 'password_reset_tokens', 'chakin_checkins',
            'promoter_comments', 'product_purchases', 'product_earning_ledger', 'user_bonuses', 'user_presence',
        ].forEach((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(user.id));
        db.prepare('DELETE FROM users WHERE id = ? AND role = \'user\'').run(user.id);
        db.exec('COMMIT');
    } catch (err) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) { /* transaction already closed */ }
        return res.status(500).json({ error: 'Could not delete user and related data.' });
    }

    logAudit({ adminId: req.user.id, action: 'user_deleted', target: user.id, previousValue: deletedUser });
    res.json({ deleted: true, id: user.id });
});

router.post('/:id/reset-password', requireAdmin, (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const temporaryPassword = crypto.randomBytes(9).toString('base64url');
    const passwordHash = bcrypt.hashSync(temporaryPassword, 10);
    db.prepare('UPDATE password_reset_tokens SET used_at = datetime(\'now\') WHERE user_id = ? AND used_at IS NULL').run(user.id);
    db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 1, auth_version = auth_version + 1 WHERE id = ?').run(passwordHash, user.id);

    logAudit({ adminId: req.user.id, action: 'password_reset_completed', target: user.id, reason: 'Temporary password assigned by Admin' });

    res.json({ temporaryPassword, mustResetPassword: true });
});

router.post('/:id/adjust-balance', requireAdmin, (req, res) => {
    const { amount, direction, reason } = req.body || {};
    const numericAmount = Math.round(Number(amount));
    if (!numericAmount || numericAmount <= 0 || !['add', 'remove'].includes(direction) || !reason) {
        return res.status(400).json({ error: 'Amount (> 0), direction (add/remove) and reason are required.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const delta = direction === 'add' ? numericAmount : -numericAmount;
    const newBalance = user.balance + delta;
    if (newBalance < 0) return res.status(400).json({ error: 'Adjustment would result in a negative balance.' });

    const txId = uuid();
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, user.id);
    db.prepare(
        'INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, \'adjustment\', ?, ?, ?, ?, ?, ?)',
    ).run(txId, user.id, delta, user.balance, newBalance, reason, txId, req.user.id);

    logAudit({
        adminId: req.user.id,
        action: direction === 'add' ? 'balance_increased' : 'balance_decreased',
        target: user.id,
        previousValue: user.balance,
        newValue: newBalance,
        reason,
    });

    res.json({ transactionId: txId, previousBalance: user.balance, newBalance });
});

module.exports = { router };
