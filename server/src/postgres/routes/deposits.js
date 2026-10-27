const express = require('express');
const { pool, transaction, uuid, getCountrySetting } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { createNotification, notifyAdmins } = require('../notifications');
const { getCountry, isValidCountryPhone } = require('../../utils/countries');

const router = express.Router();
const PHONE_ERROR_RW = 'Numero ya telefoni igomba kuba imibare 10 kandi igatangira kuri 07.';

function toPublicDeposit(row) {
    return {
        id: row.id,
        userId: row.user_id,
        userName: row.user_name,
        userPhone: row.user_phone,
        userCountryCode: row.user_country_code || null,
        currency: getCountry(row.user_country_code)?.currency || null,
        method: row.method,
        amount: row.amount,
        senderPhone: row.sender_phone,
        senderName: row.sender_name,
        paymentProof: row.payment_proof,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
    };
}

async function creditReferralCommissions(client, depositUserId, amount, depositId) {
    let currentUserId = depositUserId;
    const fallback = await client.query('SELECT level, percent FROM commissions ORDER BY level ASC');
    for (let level = 1; level <= 10; level += 1) {
        const { rows: currentRows } = await client.query('SELECT referred_by FROM users WHERE id = $1', [currentUserId]);
        const referrerId = currentRows[0]?.referred_by;
        if (!referrerId) break;
        const { rows: referrerRows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [referrerId]);
        const referrer = referrerRows[0];
        const configured = referrer && await getCountrySetting(client, referrer.country_code, 'commissions');
        const levels = Array.isArray(configured) ? configured : fallback.rows;
        const commission = levels.find((item) => Number(item.level) === level);
        if (commission && referrer) {
            const commissionAmount = Math.round(Number(amount) * Number(commission.percent) / 100);
            if (commissionAmount > 0) {
                const referenceId = `${depositId}-L${level}`;
                const existing = await client.query(
                    `SELECT id FROM reward_transactions
                     WHERE user_id = $1 AND type = 'commission' AND reference_id = $2
                     FOR UPDATE`,
                    [referrerId, referenceId],
                );
                if (!existing.rowCount) {
                    const previousBalance = Number(referrer.balance);
                    const newBalance = previousBalance + commissionAmount;
                    await client.query(
                        `INSERT INTO reward_transactions
                         (id, user_id, referred_user_id, type, amount, source, reference_id, previous_balance, new_balance, status)
                         VALUES ($1, $2, $3, 'commission', $4, $5, $6, $7, $8, 'completed')`,
                        [uuid(), referrerId, depositUserId, commissionAmount, `Referral Level ${level}`, referenceId, previousBalance, newBalance],
                    );
                    await client.query(
                        'UPDATE users SET balance = $1, commission_balance = commission_balance + $2 WHERE id = $3',
                        [newBalance, commissionAmount, referrerId],
                    );
                }
            }
        }
        currentUserId = referrerId;
    }
}

router.post('/', requireAuth, async (req, res, next) => {
    try {
        if (req.user.deposits_blocked) return res.status(403).json({ error: 'Deposits are disabled for this account.' });
        const { amount, senderPhone, senderName, paymentProof } = req.body || {};
        const method = String(req.body?.method || '').trim().toLowerCase();
        const numericAmount = Number(amount);
        const normalizedAmount = Math.round(numericAmount);
        if (!['mtn', 'airtel'].includes(method) || !Number.isFinite(numericAmount) || numericAmount <= 0 ||
            !Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0 || normalizedAmount > 2147483647) {
            return res.status(400).json({ error: 'A valid MTN or Airtel method and a positive amount are required.' });
        }
        const settings = await getCountrySetting(pool, req.user.country_code, 'deposit') || {};
        const methodSettings = settings[method] || {};
        const minimum = Number(methodSettings.min ?? settings.minimumAmount ?? 0);
        const maximum = Number(methodSettings.max ?? settings.maximumAmount ?? Number.MAX_SAFE_INTEGER);
        if (settings.enabled === false || methodSettings.enabled === false) return res.status(403).json({ error: 'Deposits are currently disabled.' });
        const currency = getCountry(req.user.country_code)?.currency || 'RWF';
        if (normalizedAmount < minimum) return res.status(400).json({ error: `Minimum deposit is ${minimum.toLocaleString()} ${currency}.` });
        if (normalizedAmount > maximum) return res.status(400).json({ error: `Maximum deposit is ${maximum.toLocaleString()} ${currency}.` });
        if (settings.proofRequired && !String(paymentProof || '').trim()) return res.status(400).json({ error: 'Enter the transaction reference from your payment receipt.' });
        if (!senderPhone || !isValidCountryPhone(req.user.country_code, senderPhone)) {
            return res.status(400).json({ error: req.user.language === 'rw' && req.user.country_code === 'RW' ? PHONE_ERROR_RW : 'Enter a valid phone number for your registered country.' });
        }
        const id = uuid();
        const deposit = await transaction(async (client) => {
            await client.query(
                `INSERT INTO deposits (id, user_id, method, amount, sender_phone, sender_name, payment_proof, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
                [id, req.user.id, method, normalizedAmount, senderPhone || null, senderName || null, paymentProof || null],
            );
            await createNotification(client, {
                recipientType: 'user',
                recipientId: req.user.id,
                type: 'deposit_submitted',
                title: 'Deposit submitted',
                message: `Your ${method.toUpperCase()} deposit is waiting for verification.`,
                relatedType: 'deposit',
                relatedId: id,
                eventKey: `deposit:${id}:submitted:user`,
            });
            await notifyAdmins(client, {
                type: 'deposit_pending',
                title: 'New deposit to verify',
                message: `${method.toUpperCase()} deposit of ${currency} ${normalizedAmount.toLocaleString()} is waiting for review.`,
                relatedType: 'deposit',
                relatedId: id,
                eventKey: `deposit:${id}:submitted`,
            });
            const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ deposit: toPublicDeposit(deposit), status: 'submitted for verification' });
    } catch (error) { return next(error); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        return res.json({ deposits: rows.map(toPublicDeposit) });
    } catch (error) { return next(error); }
});

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        const status = String(req.query.status || '').trim();
        const { rows } = await pool.query(`
            SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone, u.country_code AS user_country_code
            FROM deposits d
            JOIN users u ON u.id = d.user_id
            ${status ? 'WHERE d.status = $1' : ''}
            ORDER BY d.created_at DESC
        `, status ? [status] : []);
        return res.json({ deposits: rows.map(toPublicDeposit) });
    } catch (error) { return next(error); }
});

router.post('/:id/approve', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [req.params.id]);
            const deposit = rows[0];
            if (!deposit) return { status: 404, error: 'Deposit not found.' };
            if (deposit.status !== 'pending') return { status: 409, error: 'This deposit has already been reviewed.' };
            const { rows: users } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [deposit.user_id]);
            const user = users[0];
            if (!user) throw new Error('Deposit is linked to a missing user.');
            const previousBalance = Number(user.balance);
            const newBalance = previousBalance + Number(deposit.amount);
            await client.query('UPDATE users SET balance = $1, deposited_balance = deposited_balance + $2 WHERE id = $3', [newBalance, deposit.amount, user.id]);
            await client.query(
                "UPDATE deposits SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2",
                [req.user.id, deposit.id],
            );
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'deposit', $3, $4, $5, 'Deposit approved', $6, $7)`,
                [uuid(), user.id, deposit.amount, previousBalance, newBalance, deposit.id, req.user.id],
            );
            const { rows: bonuses } = await client.query(
                "SELECT * FROM user_bonuses WHERE user_id = $1 AND status = 'PENDING' AND deposit_required = 1 FOR UPDATE",
                [user.id],
            );
            const pendingBonus = bonuses[0];
            const bonusSetting = await getCountrySetting(client, user.country_code, 'welcomeBonus') || {};
            const qualifyingDeposit = Number(deposit.amount) >= Number(bonusSetting.minimumDeposit || 0);
            const hasProduct = pendingBonus
                ? await client.query("SELECT 1 FROM product_purchases WHERE user_id = $1 AND status = 'completed' LIMIT 1", [user.id])
                : null;
            if (pendingBonus && qualifyingDeposit && (!pendingBonus.product_required || hasProduct.rowCount > 0)) {
                await client.query("UPDATE user_bonuses SET status = 'UNLOCKED', unlocked_at = CURRENT_TIMESTAMP WHERE id = $1", [pendingBonus.id]);
                await client.query(
                    `UPDATE reward_transactions SET status = 'completed', previous_balance = $1, new_balance = $2
                     WHERE user_id = $3 AND type = 'welcome_bonus' AND reference_id = $4`,
                    [previousBalance, previousBalance + Number(pendingBonus.amount), user.id, pendingBonus.id],
                );
            }
            await creditReferralCommissions(client, user.id, deposit.amount, deposit.id);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'deposit_approved',
                target: deposit.id,
                amount: deposit.amount,
                previousValue: { status: 'pending' },
                newValue: { status: 'approved' },
            });
            await createNotification(client, {
                recipientType: 'user',
                recipientId: deposit.user_id,
                type: 'deposit_approved',
                title: 'Deposit approved',
                message: `Your ${deposit.method.toUpperCase()} deposit was approved.`,
                relatedType: 'deposit',
                relatedId: deposit.id,
                eventKey: `deposit:${deposit.id}:approved:user`,
            });
            const updated = await client.query(
                `SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone
                 FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
                [deposit.id],
            );
            return { deposit: updated.rows[0] };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ deposit: toPublicDeposit(result.deposit) });
    } catch (error) { return next(error); }
});

router.post('/:id/reject', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM deposits WHERE id = $1 FOR UPDATE', [req.params.id]);
            const deposit = rows[0];
            if (!deposit) return { status: 404, error: 'Deposit not found.' };
            if (deposit.status !== 'pending') return { status: 409, error: 'This deposit has already been reviewed.' };
            await client.query(
                "UPDATE deposits SET status = 'rejected', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2",
                [req.user.id, deposit.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'deposit_rejected',
                target: deposit.id,
                reason: req.body?.reason,
                previousValue: { status: 'pending' },
                newValue: { status: 'rejected' },
            });
            await createNotification(client, {
                recipientType: 'user',
                recipientId: deposit.user_id,
                type: 'deposit_rejected',
                title: 'Deposit rejected',
                message: `Your ${deposit.method.toUpperCase()} deposit was rejected.`,
                relatedType: 'deposit',
                relatedId: deposit.id,
                eventKey: `deposit:${deposit.id}:rejected:user`,
            });
            const updated = await client.query(
                `SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone
                 FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
                [deposit.id],
            );
            return { deposit: updated.rows[0] };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ deposit: toPublicDeposit(result.deposit) });
    } catch (error) { return next(error); }
});

module.exports = { router, toPublicDeposit, creditReferralCommissions };
