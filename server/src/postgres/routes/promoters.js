const express = require('express');
const { pool, transaction, uuid } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { verifyToken } = require('../../auth');
const { logAudit } = require('../audit');
const { publish } = require('../promoterEvents');

const router = express.Router();
const commentPromoterName = 'Comment Detected Promoters';
const allowedRestrictions = new Set(['login_blocked', 'deposits_blocked', 'withdrawals_blocked', 'product_purchase_blocked']);

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
    return {
        id: row.id,
        userId: row.user_id,
        promoterId: row.promoter_id,
        comment: row.comment,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

async function getCommentPromoter(client) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext(LOWER($1)))', [commentPromoterName]);
    const { rows } = await client.query('SELECT * FROM promoter_profiles WHERE name = $1 FOR UPDATE', [commentPromoterName]);
    if (rows[0]) return rows[0];
    const id = uuid();
    await client.query("INSERT INTO promoter_profiles (id, name, status) VALUES ($1, $2, 'active')", [id, commentPromoterName]);
    const inserted = await client.query('SELECT * FROM promoter_profiles WHERE name = $1', [commentPromoterName]);
    return inserted.rows[0];
}

router.get('/events', async (req, res, next) => {
    const token = String(req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Authentication required.' });
    let userId;
    let tokenAuthVersion;
    try {
        const payload = verifyToken(token);
        userId = payload.sub;
        if (payload.authVersion === undefined) return res.status(401).json({ error: 'Invalid session.' });
        tokenAuthVersion = Number(payload.authVersion);
    } catch (_) {
        return res.status(401).json({ error: 'Invalid session.' });
    }
    try {
        const { rows } = await pool.query("SELECT id, auth_version FROM users WHERE id = $1 AND status = 'Active'", [userId]);
        if (!rows[0] || Number(rows[0].auth_version) !== tokenAuthVersion) return res.status(401).json({ error: 'Invalid session.' });
        const lastEventId = Number(req.get('Last-Event-ID') || req.query.lastEventId || 0);
        const initial = lastEventId > 0
            ? lastEventId
            : Number((await pool.query('SELECT COALESCE(MAX(id), 0) AS id FROM promoter_events')).rows[0].id);
        let cursor = Number.isSafeInteger(initial) && initial >= 0 ? initial : 0;
        let closed = false;
        let polling = false;
        let pollTimer;
        let heartbeatTimer;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(pollTimer);
            clearInterval(heartbeatTimer);
        };
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        res.write(': connected\n\n');
        req.on('aborted', cleanup);
        res.on('close', cleanup);
        const poll = async () => {
            if (closed || polling) return;
            polling = true;
            try {
                const { rows } = await pool.query(
                    'SELECT id, event_type, payload FROM promoter_events WHERE id > $1 ORDER BY id ASC LIMIT 100',
                    [cursor],
                );
                for (const event of rows) {
                    cursor = Number(event.id);
                    if (closed) return;
                    res.write(`id: ${cursor}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
                }
            } catch (error) {
                console.error('[promoters] SSE event polling failed:', error);
                cleanup();
                res.end();
            } finally {
                polling = false;
            }
        };
        pollTimer = setInterval(poll, 1000);
        heartbeatTimer = setInterval(() => {
            if (!closed) res.write(': heartbeat\n\n');
        }, 20000);
        await poll();
    } catch (error) { return next(error); }
});

router.get('/:id/comments', requireAuth, async (req, res, next) => {
    try {
        const { rowCount } = await pool.query(
            "SELECT id FROM promoter_profiles WHERE id = $1 AND status = 'active'",
            [req.params.id],
        );
        if (!rowCount) return res.status(404).json({ error: 'Promoter not found.' });
        const { rows } = await pool.query(
            "SELECT * FROM promoter_comments WHERE promoter_id = $1 AND status = 'active' ORDER BY created_at ASC",
            [req.params.id],
        );
        return res.json({ comments: rows.map(toPublicComment) });
    } catch (error) { return next(error); }
});

router.post('/:id/comments', requireAuth, async (req, res, next) => {
    try {
        const comment = String(req.body?.comment || '').trim();
        if (!comment || comment.length > 2000) return res.status(400).json({ error: 'Comment must contain 1 to 2000 characters.' });
        const result = await transaction(async (client) => {
            const promoter = await client.query(
                "SELECT id FROM promoter_profiles WHERE id = $1 AND status = 'active' FOR UPDATE",
                [req.params.id],
            );
            if (!promoter.rowCount) return null;
            const id = uuid();
            const { rows } = await client.query(
                `INSERT INTO promoter_comments (id, user_id, promoter_id, comment, status)
                 VALUES ($1, $2, $3, $4, 'active') RETURNING *`,
                [id, req.user.id, req.params.id, comment],
            );
            const publicComment = toPublicComment(rows[0]);
            await publish(client, 'PROMOTER_COMMENT_CREATED', publicComment);
            return publicComment;
        });
        if (!result) return res.status(404).json({ error: 'Promoter not found.' });
        return res.status(201).json({ comment: result });
    } catch (error) { return next(error); }
});

router.put('/comments/:commentId', requireAuth, async (req, res, next) => {
    try {
        const comment = String(req.body?.comment || '').trim();
        if (!comment || comment.length > 2000) return res.status(400).json({ error: 'Comment must contain 1 to 2000 characters.' });
        const result = await transaction(async (client) => {
            const { rows } = await client.query(
                "SELECT * FROM promoter_comments WHERE id = $1 AND status = 'active' FOR UPDATE",
                [req.params.commentId],
            );
            const existing = rows[0];
            if (!existing) return { status: 404, error: 'Comment not found.' };
            if (existing.user_id !== req.user.id && req.user.role !== 'admin') return { status: 403, error: 'You can only edit your own comment.' };
            const updated = await client.query(
                'UPDATE promoter_comments SET comment = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
                [comment, existing.id],
            );
            const publicComment = toPublicComment(updated.rows[0]);
            await publish(client, 'PROMOTER_COMMENT_UPDATED', publicComment);
            return { comment: publicComment };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ comment: result.comment });
    } catch (error) { return next(error); }
});

router.delete('/comments/:commentId', requireAuth, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query(
                "SELECT * FROM promoter_comments WHERE id = $1 AND status = 'active' FOR UPDATE",
                [req.params.commentId],
            );
            const comment = rows[0];
            if (!comment) return { status: 404, error: 'Comment not found.' };
            if (comment.user_id !== req.user.id && req.user.role !== 'admin') return { status: 403, error: 'You can only delete your own comment.' };
            await client.query(
                "UPDATE promoter_comments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
                [comment.id],
            );
            await publish(client, 'PROMOTER_COMMENT_DELETED', {
                commentId: comment.id,
                promoterId: comment.promoter_id,
                timestamp: new Date().toISOString(),
            });
            return { ok: true };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.get('/me', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT u.*, p.name AS promoter_name, p.status AS promoter_status
            FROM users u LEFT JOIN promoter_profiles p ON p.id = u.promoter_id
            WHERE u.id = $1 AND u.role = 'user'
        `, [req.user.id]);
        const user = rows[0];
        if (!user || !user.promoter_id) return res.json({ promoter: null });
        return res.json({
            promoter: { id: user.promoter_id, name: user.promoter_name, status: user.promoter_status, comment: user.promoter_comment || null, assignedAt: user.promoter_assigned_at || null },
        });
    } catch (error) { return next(error); }
});

router.put('/me/comment', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query("SELECT id FROM users WHERE id = $1 AND role = 'user'", [req.user.id]);
        const user = rows[0];
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const comment = String(req.body?.comment || '').trim() || null;
        await pool.query('UPDATE users SET promoter_comment = $1 WHERE id = $2', [comment, user.id]);
        return res.json({ comment, updatedAt: new Date().toISOString() });
    } catch (error) { return next(error); }
});

router.get('/', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*,
                (SELECT COUNT(*) FROM users u WHERE u.promoter_id = p.id AND u.role = 'user') AS total_users,
                (SELECT COUNT(*) FROM users u WHERE u.promoter_id = p.id AND u.role = 'user' AND u.status = 'Active') AS active_users,
                (SELECT COUNT(DISTINCT pp.user_id) FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.promoter_id = p.id AND u.role = 'user' AND pp.status = 'completed') AS purchasing_users,
                (SELECT COALESCE(SUM(d.amount), 0) FROM deposits d JOIN users u ON u.id = d.user_id WHERE u.promoter_id = p.id AND d.status = 'approved') AS deposits,
                (SELECT COALESCE(SUM(w.amount), 0) FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE u.promoter_id = p.id AND w.status IN ('approved', 'paid')) AS withdrawals,
                (SELECT COUNT(*) FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.promoter_id = p.id AND pp.status = 'completed') AS product_purchases
            FROM promoter_profiles p ORDER BY p.created_at DESC
        `);
        return res.json({ promoters: rows.map(promoterSummary) });
    } catch (error) { return next(error); }
});

router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const name = String(req.body?.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Promoter name is required.' });
        const result = await transaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext(LOWER($1)))', [name]);
            const exists = await client.query('SELECT 1 FROM promoter_profiles WHERE LOWER(name) = LOWER($1)', [name]);
            if (exists.rowCount) return null;
            const id = uuid();
            await client.query('INSERT INTO promoter_profiles (id, name) VALUES ($1, $2)', [id, name]);
            await logAudit(client, { adminId: req.user.id, action: 'promoter_created', target: id, newValue: { name } });
            const { rows } = await client.query('SELECT * FROM promoter_profiles WHERE id = $1', [id]);
            return rows[0];
        });
        if (!result) return res.status(409).json({ error: 'Promoter already exists.' });
        return res.status(201).json({ promoter: promoterSummary(result) });
    } catch (error) { return next(error); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
    try {
        const promoter = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM promoter_profiles WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const name = req.body?.name === undefined ? existing.name : String(req.body.name).trim();
            const status = req.body?.status === undefined ? existing.status : String(req.body.status).toLowerCase();
            if (!name || !['active', 'inactive'].includes(status)) return { error: 'Valid name and status are required.' };
            await client.query('UPDATE promoter_profiles SET name = $1, status = $2 WHERE id = $3', [name, status, existing.id]);
            await logAudit(client, { adminId: req.user.id, action: 'promoter_updated', target: existing.id, previousValue: existing, newValue: { name, status } });
            const updated = await client.query('SELECT * FROM promoter_profiles WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!promoter) return res.status(404).json({ error: 'Promoter not found.' });
        if (promoter.error) return res.status(400).json({ error: promoter.error });
        return res.json({ promoter: promoterSummary(promoter) });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM promoter_profiles WHERE id = $1 FOR UPDATE', [req.params.id]);
            const promoter = rows[0];
            if (!promoter) return null;
            await client.query(
                'UPDATE users SET promoter_id = NULL, promoter_comment = NULL, promoter_assigned_at = NULL WHERE promoter_id = $1',
                [promoter.id],
            );
            await client.query(
                "UPDATE promoter_comments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE promoter_id = $1",
                [promoter.id],
            );
            await client.query('DELETE FROM promoter_profiles WHERE id = $1', [promoter.id]);
            await logAudit(client, { adminId: req.user.id, action: 'promoter_deleted', target: promoter.id, previousValue: promoter });
            await publish(client, 'PROMOTER_DELETED', { promoterId: promoter.id, timestamp: new Date().toISOString() });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Promoter not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.put('/users/:userId', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query("SELECT * FROM users WHERE id = $1 AND role = 'user' FOR UPDATE", [req.params.userId]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            const submittedId = req.body?.promoterId ? String(req.body.promoterId).trim() : null;
            const comment = String(req.body?.comment || '').trim() || null;
            const commentQualifies = /\bpromoter\b/i.test(comment || '');
            const previousCommentQualifies = /\bpromoter\b/i.test(user.promoter_comment || '');
            const promoterId = commentQualifies
                ? (await getCommentPromoter(client)).id
                : (previousCommentQualifies ? null : submittedId);
            const { rows: promoterRows } = promoterId
                ? await client.query("SELECT * FROM promoter_profiles WHERE id = $1 AND status = 'active'", [promoterId])
                : { rows: [] };
            const promoter = promoterRows[0] || null;
            if (promoterId && !promoter) return { status: 400, error: 'Valid active promoter is required.' };
            const previous = { promoterId: user.promoter_id || null, comment: user.promoter_comment || null };
            const next = { promoterId, comment, detectedFromComment: commentQualifies };
            await client.query(
                'UPDATE users SET promoter_id = $1, promoter_comment = $2, promoter_assigned_at = $3 WHERE id = $4',
                [promoterId, comment, promoterId ? new Date() : null, user.id],
            );
            const logs = [];
            if (!previous.promoterId && promoterId) logs.push(['promoter_assigned', previous, next]);
            else if (previous.promoterId && !promoterId) logs.push(['promoter_removed', previous, next]);
            else if (previous.promoterId !== promoterId) logs.push(['promoter_changed', previous, next]);
            if (previous.comment !== comment) logs.push([previous.comment ? 'promoter_comment_edited' : 'promoter_comment_added', previous, next]);
            for (const [action, previousValue, newValue] of logs) {
                await logAudit(client, { adminId: req.user.id, action, target: user.id, previousValue, newValue });
            }
            return { user: { id: user.id, promoterId, promoterName: promoter?.name || null, comment } };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ user: result.user });
    } catch (error) { return next(error); }
});

router.post('/users/:userId/promote', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query("SELECT * FROM users WHERE id = $1 AND role = 'user' FOR UPDATE", [req.params.userId]);
            const user = rows[0];
            if (!user) return { status: 404, error: 'User not found.' };
            if (user.promoter_id) return { status: 409, error: 'This user is already a promoter.' };
            const comment = String(req.body?.comment || '').trim() || null;
            const promoterId = uuid();
            await client.query(
                "INSERT INTO promoter_profiles (id, name, status) VALUES ($1, $2, 'active')",
                [promoterId, user.full_name],
            );
            await client.query(
                'UPDATE users SET promoter_id = $1, promoter_comment = $2, promoter_assigned_at = CURRENT_TIMESTAMP WHERE id = $3',
                [promoterId, comment, user.id],
            );
            await logAudit(client, { adminId: req.user.id, action: 'user_promoted', target: user.id, newValue: { promoterId, comment } });
            await publish(client, 'PROMOTER_CREATED', { promoterId, userId: user.id, timestamp: new Date().toISOString() });
            return { status: 201, user: { id: user.id, promoterId, promoterName: user.full_name, comment } };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.status(result.status).json({ user: result.user });
    } catch (error) { return next(error); }
});

router.get('/:id/users', requireAdmin, async (req, res, next) => {
    try {
        const { rowCount } = await pool.query('SELECT 1 FROM promoter_profiles WHERE id = $1', [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Promoter not found.' });
        const { rows } = await pool.query(`
            SELECT u.id, u.full_name, u.phone_number, u.created_at, u.status, u.promoter_comment, u.promoter_assigned_at,
                (SELECT COALESCE(SUM(amount), 0) FROM deposits WHERE user_id = u.id AND status = 'approved') AS deposits,
                (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE user_id = u.id AND status IN ('approved', 'paid')) AS withdrawals,
                (SELECT COUNT(*) FROM product_purchases WHERE user_id = u.id AND status = 'completed') AS product_purchases
            FROM users u WHERE u.promoter_id = $1 AND u.role = 'user' ORDER BY u.promoter_assigned_at DESC
        `, [req.params.id]);
        return res.json({
            users: rows.map((user) => ({
                id: user.id, fullName: user.full_name, phoneNumber: user.phone_number,
                createdAt: user.created_at, status: user.status, comment: user.promoter_comment,
                assignedAt: user.promoter_assigned_at, deposits: Number(user.deposits || 0),
                withdrawals: Number(user.withdrawals || 0), productPurchases: Number(user.product_purchases || 0),
            })),
        });
    } catch (error) { return next(error); }
});

async function getPromoterUser(client, id, lock = false) {
    const { rows } = await client.query(`
        SELECT p.id AS promoter_id, u.* FROM promoter_profiles p
        JOIN users u ON u.promoter_id = p.id
        WHERE p.id = $1 AND u.role = 'user' ${lock ? 'FOR UPDATE OF u' : ''}
    `, [id]);
    return rows[0] || null;
}

router.get('/:id/control', requireAdmin, async (req, res, next) => {
    try {
        const promoter = await getPromoterUser(pool, req.params.id);
        if (!promoter) return res.status(404).json({ error: 'Promoter user not found.' });
        return res.json({
            user: {
                id: promoter.id, fullName: promoter.full_name, promoterId: promoter.promoter_id,
                comment: promoter.promoter_comment, status: promoter.status,
                loginBlocked: Boolean(promoter.login_blocked), depositsBlocked: Boolean(promoter.deposits_blocked),
                withdrawalsBlocked: Boolean(promoter.withdrawals_blocked),
                productPurchaseBlocked: Boolean(promoter.product_purchase_blocked), balance: Number(promoter.balance),
            },
        });
    } catch (error) { return next(error); }
});

router.post('/:id/control/restriction', requireAdmin, async (req, res, next) => {
    try {
        const key = String(req.body?.key || '');
        if (!allowedRestrictions.has(key) || typeof req.body?.blocked !== 'boolean') {
            return res.status(400).json({ error: 'Valid restriction key and blocked value are required.' });
        }
        const result = await transaction(async (client) => {
            const row = await getPromoterUser(client, req.params.id, true);
            if (!row) return null;
            const previous = Boolean(row[key]);
            await client.query(`UPDATE users SET ${key} = $1 WHERE id = $2`, [req.body.blocked ? 1 : 0, row.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: req.body.blocked ? `promoter_block_${key}` : `promoter_unblock_${key}`,
                target: row.id,
                previousValue: previous,
                newValue: req.body.blocked,
            });
            return { previous, blocked: req.body.blocked };
        });
        if (!result) return res.status(404).json({ error: 'Promoter user not found.' });
        return res.json({ ok: true, ...result });
    } catch (error) { return next(error); }
});

router.post('/:id/control/account', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const row = await getPromoterUser(client, req.params.id, true);
            if (!row) return null;
            const status = req.body?.blocked ? 'Blocked' : 'Active';
            await client.query('UPDATE users SET status = $1, auth_version = auth_version + 1 WHERE id = $2', [status, row.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: req.body?.blocked ? 'promoter_account_blocked' : 'promoter_account_unblocked',
                target: row.id,
                previousValue: row.status,
                newValue: status,
            });
            return status;
        });
        if (!result) return res.status(404).json({ error: 'Promoter user not found.' });
        return res.json({ ok: true, status: result });
    } catch (error) { return next(error); }
});

router.post('/:id/control/balance', requireAdmin, async (req, res, next) => {
    try {
        const amount = Math.round(Number(req.body?.amount));
        const direction = req.body?.direction;
        const reason = String(req.body?.reason || '').trim();
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2147483647 ||
            !['add', 'remove'].includes(direction) || !reason) {
            return res.status(400).json({ error: 'Amount, direction and reason are required.' });
        }
        const result = await transaction(async (client) => {
            const row = await getPromoterUser(client, req.params.id, true);
            if (!row) return { error: 'Promoter user not found.', status: 404 };
            const previousBalance = Number(row.balance);
            const nextBalance = previousBalance + (direction === 'add' ? amount : -amount);
            if (nextBalance < 0 || nextBalance > 2147483647) return { error: 'Balance must remain within the supported range.', status: 400 };
            const txId = uuid();
            await client.query('UPDATE users SET balance = $1 WHERE id = $2', [nextBalance, row.id]);
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'adjustment', $3, $4, $5, $6, $7, $8)`,
                [txId, row.id, direction === 'add' ? amount : -amount, previousBalance, nextBalance, reason, txId, req.user.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: direction === 'add' ? 'promoter_money_added' : 'promoter_money_deducted',
                target: row.id,
                amount,
                previousValue: previousBalance,
                newValue: nextBalance,
                reason,
            });
            return { balance: nextBalance };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ ok: true, balance: result.balance });
    } catch (error) { return next(error); }
});

router.post('/:id/control/remove-status', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const row = await getPromoterUser(client, req.params.id, true);
            if (!row) return null;
            await client.query(
                'UPDATE users SET promoter_id = NULL, promoter_comment = NULL, promoter_assigned_at = NULL WHERE id = $1',
                [row.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'promoter_status_removed',
                target: row.id,
                previousValue: { promoterId: row.promoter_id, comment: row.promoter_comment },
                newValue: { promoterId: null, comment: null },
            });
            return true;
        });
        if (!result) return res.status(404).json({ error: 'Promoter user not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.delete('/:id/control/delete-account', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const row = await getPromoterUser(client, req.params.id, true);
            if (!row) return false;
            await logAudit(client, {
                adminId: req.user.id,
                action: 'PERMANENT_ACCOUNT_DELETION',
                target: row.id,
                previousValue: { fullName: row.full_name, promoterId: row.promoter_id, status: row.status },
                newValue: { account: 'deleted' },
                reason: req.body?.reason,
            });
            await client.query('UPDATE users SET referred_by = NULL WHERE referred_by = $1', [row.id]);
            for (const table of [
                'transactions', 'deposits', 'withdrawals', 'task_claims', 'gift_code_redemptions',
                'spin_results', 'reward_transactions', 'password_reset_tokens', 'chakin_checkins',
                'product_purchases', 'product_earning_ledger', 'user_bonuses',
            ]) {
                await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [row.id]);
            }
            await client.query(
                "UPDATE promoter_comments SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 OR promoter_id = $2",
                [row.id, row.promoter_id],
            );
            await client.query('DELETE FROM users WHERE id = $1', [row.id]);
            const remaining = await client.query('SELECT 1 FROM users WHERE promoter_id = $1 LIMIT 1', [row.promoter_id]);
            if (!remaining.rowCount) await client.query('DELETE FROM promoter_profiles WHERE id = $1', [row.promoter_id]);
            await publish(client, 'PROMOTER_DELETED', { promoterId: row.promoter_id, timestamp: new Date().toISOString() });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Promoter user not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

module.exports = { router, promoterSummary, toPublicComment, getCommentPromoter };
