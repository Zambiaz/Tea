const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { verifyToken } = require('../auth');
const { logAudit } = require('../utils/auditLogger');
const { addClient, publish } = require('../utils/promoterEvents');

const router = express.Router();
const COMMENT_PROMOTER_NAME = 'Comment Detected Promoters';

function getCommentPromoter() {
    let promoter = db.prepare('SELECT * FROM promoter_profiles WHERE name = ?').get(COMMENT_PROMOTER_NAME);
    if (!promoter) {
        const id = uuid();
        db.prepare("INSERT INTO promoter_profiles (id, name, status) VALUES (?, ?, 'active')").run(id, COMMENT_PROMOTER_NAME);
        promoter = db.prepare('SELECT * FROM promoter_profiles WHERE id = ?').get(id);
    }
    return promoter;
}

function promoterSummary(row) {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        totalUsers: Number(row.total_users || 0),
        activeUsers: Number(row.active_users || 0),
        purchasingUsers: Number(row.purchasing_users || 0),
        deposits: Number(row.deposits || 0),
        withdrawals: Number(row.withdrawals || 0),
        productPurchases: Number(row.product_purchases || 0),
    };
}

function toPublicComment(row) {
    return { id: row.id, userId: row.user_id, promoterId: row.promoter_id, comment: row.comment, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

router.get('/events', (req, res) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    try {
        const payload = verifyToken(token);
        if (!db.prepare("SELECT id FROM users WHERE id = ? AND status = 'Active'").get(payload.sub)) return res.status(401).json({ error: 'Invalid session.' });
    } catch (error) { return res.status(401).json({ error: 'Invalid session.' }); }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');
    addClient(res);
});

router.get('/:id/comments', requireAuth, (req, res) => {
    if (!db.prepare("SELECT id FROM promoter_profiles WHERE id = ? AND status = 'active'").get(req.params.id)) return res.status(404).json({ error: 'Promoter not found.' });
    const rows = db.prepare("SELECT * FROM promoter_comments WHERE promoter_id = ? AND status = 'active' ORDER BY created_at ASC").all(req.params.id);
    res.json({ comments: rows.map(toPublicComment) });
});

router.post('/:id/comments', requireAuth, (req, res) => {
    const promoter = db.prepare("SELECT id FROM promoter_profiles WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!promoter) return res.status(404).json({ error: 'Promoter not found.' });
    const comment = String(req.body?.comment || '').trim();
    if (!comment || comment.length > 2000) return res.status(400).json({ error: 'Comment must contain 1 to 2000 characters.' });
    const id = uuid();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO promoter_comments (id, user_id, promoter_id, comment, status, created_at, updated_at) VALUES (?, ?, ?, ?, \'active\', ?, ?)').run(id, req.user.id, promoter.id, comment, now, now);
    const result = toPublicComment(db.prepare('SELECT * FROM promoter_comments WHERE id = ?').get(id));
    publish('PROMOTER_COMMENT_CREATED', result);
    res.status(201).json({ comment: result });
});

router.put('/comments/:commentId', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM promoter_comments WHERE id = ? AND status = \'active\'').get(req.params.commentId);
    if (!row) return res.status(404).json({ error: 'Comment not found.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only edit your own comment.' });
    const comment = String(req.body?.comment || '').trim();
    if (!comment || comment.length > 2000) return res.status(400).json({ error: 'Comment must contain 1 to 2000 characters.' });
    db.prepare("UPDATE promoter_comments SET comment = ?, updated_at = datetime('now') WHERE id = ?").run(comment, row.id);
    const result = toPublicComment(db.prepare('SELECT * FROM promoter_comments WHERE id = ?').get(row.id));
    publish('PROMOTER_COMMENT_UPDATED', result);
    res.json({ comment: result });
});

router.delete('/comments/:commentId', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM promoter_comments WHERE id = ? AND status = \'active\'').get(req.params.commentId);
    if (!row) return res.status(404).json({ error: 'Comment not found.' });
    if (row.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own comment.' });
    db.prepare("UPDATE promoter_comments SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").run(row.id);
    publish('PROMOTER_COMMENT_DELETED', { commentId: row.id, promoterId: row.promoter_id, timestamp: new Date().toISOString() });
    res.json({ ok: true });
});

// Authenticated promoter view: returns the persisted relationship/comment immediately.
router.get('/me', requireAuth, (req, res) => {
    const user = db.prepare(`SELECT u.*, p.name AS promoter_name, p.status AS promoter_status
        FROM users u LEFT JOIN promoter_profiles p ON p.id = u.promoter_id
        WHERE u.id = ? AND u.role = 'user'`).get(req.user.id);
    res.json({ promoter: user.promoter_id ? { id: user.promoter_id, name: user.promoter_name, status: user.promoter_status, comment: user.promoter_comment || null, assignedAt: user.promoter_assigned_at || null } : null });
});

router.put('/me/comment', requireAuth, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const comment = String(req.body?.comment || '').trim() || null;
    db.prepare('UPDATE users SET promoter_comment = ? WHERE id = ?').run(comment, user.id);
    res.json({ comment, updatedAt: new Date().toISOString() });
});

router.get('/', requireAdmin, (req, res) => {
    const rows = db.prepare(`
        SELECT p.*,
            (SELECT COUNT(*) FROM users u WHERE u.promoter_id = p.id AND u.role = 'user') AS total_users,
            (SELECT COUNT(*) FROM users u WHERE u.promoter_id = p.id AND u.role = 'user' AND u.status = 'Active') AS active_users,
            (SELECT COUNT(DISTINCT pp.user_id) FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.promoter_id = p.id AND u.role = 'user' AND pp.status = 'completed') AS purchasing_users,
            (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d JOIN users u ON u.id = d.user_id WHERE u.promoter_id = p.id AND d.status = 'approved') AS deposits,
            (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.promoter_id = p.id AND w.status IN ('approved', 'paid')) AS withdrawals,
            (SELECT COUNT(*) FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.promoter_id = p.id AND pp.status = 'completed') AS product_purchases
        FROM promoter_profiles p ORDER BY p.created_at DESC
    `).all();
    res.json({ promoters: rows.map(promoterSummary) });
});

router.post('/', requireAdmin, (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Promoter name is required.' });
    if (db.prepare('SELECT 1 FROM promoter_profiles WHERE LOWER(name) = LOWER(?)').get(name)) return res.status(409).json({ error: 'Promoter already exists.' });
    const id = uuid();
    db.prepare('INSERT INTO promoter_profiles (id, name) VALUES (?, ?)').run(id, name);
    logAudit({ adminId: req.user.id, action: 'promoter_created', target: id, newValue: { name } });
    res.status(201).json({ promoter: promoterSummary(db.prepare('SELECT * FROM promoter_profiles WHERE id = ?').get(id)) });
});

router.patch('/:id', requireAdmin, (req, res) => {
    const promoter = db.prepare('SELECT * FROM promoter_profiles WHERE id = ?').get(req.params.id);
    if (!promoter) return res.status(404).json({ error: 'Promoter not found.' });
    const name = req.body?.name === undefined ? promoter.name : String(req.body.name).trim();
    const status = req.body?.status === undefined ? promoter.status : String(req.body.status).toLowerCase();
    if (!name || !['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'Valid name and status are required.' });
    db.prepare('UPDATE promoter_profiles SET name = ?, status = ? WHERE id = ?').run(name, status, promoter.id);
    logAudit({ adminId: req.user.id, action: 'promoter_updated', target: promoter.id, previousValue: promoter, newValue: { name, status } });
    res.json({ promoter: promoterSummary(db.prepare('SELECT * FROM promoter_profiles WHERE id = ?').get(promoter.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
    const promoter = db.prepare('SELECT * FROM promoter_profiles WHERE id = ?').get(req.params.id);
    if (!promoter) return res.status(404).json({ error: 'Promoter not found.' });
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('UPDATE users SET promoter_id = NULL, promoter_comment = NULL, promoter_assigned_at = NULL WHERE promoter_id = ?').run(promoter.id);
        db.prepare("UPDATE promoter_comments SET status = 'deleted', updated_at = datetime('now') WHERE promoter_id = ?").run(promoter.id);
        db.prepare('DELETE FROM promoter_profiles WHERE id = ?').run(promoter.id);
        db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not remove promoter.' }); }
    logAudit({ adminId: req.user.id, action: 'promoter_deleted', target: promoter.id, previousValue: promoter });
    publish('PROMOTER_DELETED', { promoterId: promoter.id, timestamp: new Date().toISOString() });
    res.json({ ok: true });
});

router.put('/users/:userId', requireAdmin, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const submittedPromoterId = req.body?.promoterId ? String(req.body.promoterId).trim() : null;
    const comment = String(req.body?.comment || '').trim() || null;
    const commentQualifies = /\bpromoter\b/i.test(comment || '');
    const previousCommentQualifies = /\bpromoter\b/i.test(user.promoter_comment || '');
    const promoterId = commentQualifies ? getCommentPromoter().id : (previousCommentQualifies ? null : submittedPromoterId);
    const promoter = promoterId ? db.prepare("SELECT * FROM promoter_profiles WHERE id = ? AND status = 'active'").get(promoterId) : null;
    if (promoterId && !promoter) return res.status(400).json({ error: 'Valid active promoter is required.' });
    const previous = { promoterId: user.promoter_id || null, comment: user.promoter_comment || null };
    const next = { promoterId, comment, detectedFromComment: commentQualifies };
    db.prepare('UPDATE users SET promoter_id = ?, promoter_comment = ?, promoter_assigned_at = ? WHERE id = ?').run(promoterId, comment, promoterId ? new Date().toISOString() : null, user.id);
    if (!previous.promoterId && promoterId) logAudit({ adminId: req.user.id, action: 'promoter_assigned', target: user.id, previousValue: previous, newValue: next });
    else if (previous.promoterId && !promoterId) logAudit({ adminId: req.user.id, action: 'promoter_removed', target: user.id, previousValue: previous, newValue: next });
    else if (previous.promoterId !== promoterId) logAudit({ adminId: req.user.id, action: 'promoter_changed', target: user.id, previousValue: previous, newValue: next });
    if (previous.comment !== comment) logAudit({ adminId: req.user.id, action: previous.comment ? 'promoter_comment_edited' : 'promoter_comment_added', target: user.id, previousValue: previous, newValue: next });
    res.json({ user: { id: user.id, promoterId, promoterName: promoter?.name || null, comment } });
});

router.post('/users/:userId/promote', requireAdmin, (req, res) => {
    const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.promoter_id) return res.status(409).json({ error: 'This user is already a promoter.' });
    const comment = String(req.body?.comment || '').trim() || null;
    const promoterId = uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('INSERT INTO promoter_profiles (id, name, status) VALUES (?, ?, \'active\')').run(promoterId, user.full_name);
        db.prepare('UPDATE users SET promoter_id = ?, promoter_comment = ?, promoter_assigned_at = datetime(\'now\') WHERE id = ?').run(promoterId, comment, user.id);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Could not promote this user.' });
    }
    logAudit({ adminId: req.user.id, action: 'user_promoted', target: user.id, newValue: { promoterId, comment } });
    publish('PROMOTER_CREATED', { promoterId, userId: user.id, timestamp: new Date().toISOString() });
    res.status(201).json({ user: { id: user.id, promoterId, promoterName: user.full_name, comment } });
});

router.get('/:id/users', requireAdmin, (req, res) => {
    if (!db.prepare('SELECT 1 FROM promoter_profiles WHERE id = ?').get(req.params.id)) return res.status(404).json({ error: 'Promoter not found.' });
    const users = db.prepare(`SELECT u.id, u.full_name, u.phone_number, u.created_at, u.status, u.promoter_comment, u.promoter_assigned_at,
        (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE user_id = u.id AND status = 'approved') AS deposits,
        (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = u.id AND status IN ('approved', 'paid')) AS withdrawals,
        (SELECT COUNT(*) FROM product_purchases WHERE user_id = u.id AND status = 'completed') AS product_purchases
        FROM users u WHERE u.promoter_id = ? AND u.role = 'user' ORDER BY u.promoter_assigned_at DESC`).all(req.params.id);
    res.json({ users: users.map((user) => ({ id: user.id, fullName: user.full_name, phoneNumber: user.phone_number, createdAt: user.created_at, status: user.status, comment: user.promoter_comment, assignedAt: user.promoter_assigned_at, deposits: Number(user.deposits || 0), withdrawals: Number(user.withdrawals || 0), productPurchases: Number(user.product_purchases || 0) })) });
});

router.get('/:id/control', requireAdmin, (req, res) => {
    const promoter = db.prepare('SELECT p.id AS promoter_id, u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!promoter) return res.status(404).json({ error: 'Promoter user not found.' });
    res.json({ user: { id: promoter.id, fullName: promoter.full_name, promoterId: promoter.promoter_id, comment: promoter.promoter_comment, status: promoter.status, loginBlocked: !!promoter.login_blocked, depositsBlocked: !!promoter.deposits_blocked, withdrawalsBlocked: !!promoter.withdrawals_blocked, productPurchaseBlocked: !!promoter.product_purchase_blocked, balance: promoter.balance } });
});

router.post('/:id/control/restriction', requireAdmin, (req, res) => {
    const allowed = new Set(['login_blocked', 'deposits_blocked', 'withdrawals_blocked', 'product_purchase_blocked']);
    const key = String(req.body?.key || '');
    if (!allowed.has(key) || typeof req.body?.blocked !== 'boolean') return res.status(400).json({ error: 'Valid restriction key and blocked value are required.' });
    const row = db.prepare('SELECT u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Promoter user not found.' });
    const previous = !!row[key];
    db.prepare(`UPDATE users SET ${key} = ? WHERE id = ?`).run(req.body.blocked ? 1 : 0, row.id);
    logAudit({ adminId: req.user.id, action: req.body.blocked ? `promoter_block_${key}` : `promoter_unblock_${key}`, target: row.id, previousValue: previous, newValue: req.body.blocked, status: 'success' });
    res.json({ ok: true, previous, blocked: req.body.blocked });
});

router.post('/:id/control/account', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Promoter user not found.' });
    const status = req.body?.blocked ? 'Blocked' : 'Active';
    db.prepare('UPDATE users SET status = ?, auth_version = auth_version + 1 WHERE id = ?').run(status, row.id);
    logAudit({ adminId: req.user.id, action: req.body?.blocked ? 'promoter_account_blocked' : 'promoter_account_unblocked', target: row.id, previousValue: row.status, newValue: status, status: 'success' });
    res.json({ ok: true, status });
});

router.post('/:id/control/balance', requireAdmin, (req, res) => {
    const amount = Math.round(Number(req.body?.amount));
    const direction = req.body?.direction;
    const reason = String(req.body?.reason || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || !['add', 'remove'].includes(direction) || !reason) return res.status(400).json({ error: 'Amount, direction and reason are required.' });
    const row = db.prepare('SELECT u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Promoter user not found.' });
    const nextBalance = row.balance + (direction === 'add' ? amount : -amount);
    if (nextBalance < 0) return res.status(400).json({ error: 'Balance cannot become negative.' });
    const txId = uuid();
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(nextBalance, row.id);
    db.prepare('INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, \'adjustment\', ?, ?, ?, ?, ?, ?)').run(txId, row.id, direction === 'add' ? amount : -amount, row.balance, nextBalance, reason, txId, req.user.id);
    logAudit({ adminId: req.user.id, action: direction === 'add' ? 'promoter_money_added' : 'promoter_money_deducted', target: row.id, amount, previousValue: row.balance, newValue: nextBalance, reason, status: 'success' });
    res.json({ ok: true, balance: nextBalance });
});

router.post('/:id/control/remove-status', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Promoter user not found.' });
    db.prepare('UPDATE users SET promoter_id = NULL, promoter_comment = NULL, promoter_assigned_at = NULL WHERE id = ?').run(row.id);
    logAudit({ adminId: req.user.id, action: 'promoter_status_removed', target: row.id, previousValue: { promoterId: row.promoter_id, comment: row.promoter_comment }, newValue: { promoterId: null, comment: null }, status: 'success' });
    res.json({ ok: true });
});

router.delete('/:id/control/delete-account', requireAdmin, (req, res) => {
    const row = db.prepare('SELECT p.id AS promoter_profile_id, u.* FROM promoter_profiles p JOIN users u ON u.promoter_id = p.id WHERE p.id = ? AND u.role = \'user\'').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Promoter user not found.' });
    db.exec('BEGIN IMMEDIATE');
    try {
        logAudit({ adminId: req.user.id, action: 'PERMANENT_ACCOUNT_DELETION', target: row.id, previousValue: { fullName: row.full_name, promoterId: row.promoter_id, status: row.status }, newValue: { account: 'deleted' }, status: 'success', reason: req.body?.reason });
        db.prepare('UPDATE users SET referred_by = NULL WHERE referred_by = ?').run(row.id);
        ['transactions', 'deposits', 'withdrawals', 'task_claims', 'gift_code_redemptions', 'spin_results', 'reward_transactions', 'password_reset_tokens', 'chakin_checkins', 'product_purchases', 'product_earning_ledger', 'user_bonuses'].forEach((table) => db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(row.id));
        db.prepare("UPDATE promoter_comments SET status = 'deleted', updated_at = datetime('now') WHERE user_id = ? OR promoter_id = ?").run(row.id, row.promoter_id);
        db.prepare('DELETE FROM users WHERE id = ?').run(row.id);
        if (!db.prepare('SELECT 1 FROM users WHERE promoter_id = ? LIMIT 1').get(row.promoter_profile_id)) db.prepare('DELETE FROM promoter_profiles WHERE id = ?').run(row.promoter_profile_id);
        db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); return res.status(500).json({ error: 'Could not permanently delete promoter account.' }); }
    publish('PROMOTER_DELETED', { promoterId: row.promoter_id, timestamp: new Date().toISOString() });
    res.json({ ok: true });
});

module.exports = { router };
