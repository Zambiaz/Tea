// Deposit requests: users submit, admins review. Never auto-increase balance on submit --
// only an explicit admin approval credits the user's wallet.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { notifyUser, notifyAdmins } = require('../utils/notifications');
const { getCountry, getCountrySetting, isValidCountryPhone } = require('../utils/countries');

const router = express.Router();
const PHONE_ERROR_RW = 'Numero ya telefoni igomba kuba imibare 10 kandi igatangira kuri 07.';

// Referral commissions are paid up the referred_by chain according to the `commissions` levels
// table. Reuses reward_transactions' unique (user_id, type, reference_id) index so re-approving
// or retrying never pays the same deposit's commission twice.
function creditReferralCommissions(depositUserId, amount, depositId) {
    let currentUserId = depositUserId;
    const fallbackLevels = db.prepare('SELECT level, percent FROM commissions ORDER BY level ASC').all();
    for (let level = 1; level <= 10; level += 1) {
        const current = db.prepare('SELECT referred_by FROM users WHERE id = ?').get(currentUserId);
        if (!current || !current.referred_by) break;
        const referrerId = current.referred_by;
        const referrer = db.prepare('SELECT * FROM users WHERE id = ?').get(referrerId);
        const countryLevels = referrer && getCountrySetting(db, referrer.country_code, 'commissions');
        const commissionLevels = Array.isArray(countryLevels) ? countryLevels : fallbackLevels;
        const commission = commissionLevels.find((item) => Number(item.level) === level);
        if (!commission) {
            currentUserId = referrerId;
            continue;
        }
        const { percent } = commission;
        const commissionAmount = Math.round((Number(amount) * Number(percent)) / 100);
        if (commissionAmount > 0) {
            if (referrer) {
                const newBalance = referrer.balance + commissionAmount;
                const result = db.prepare('INSERT OR IGNORE INTO reward_transactions (id, user_id, referred_user_id, type, amount, source, reference_id, previous_balance, new_balance) VALUES (?, ?, ?, \'commission\', ?, ?, ?, ?, ?)')
                    .run(uuid(), referrerId, depositUserId, commissionAmount, `Referral Level ${level}`, `${depositId}-L${level}`, referrer.balance, newBalance);
                if (result.changes > 0) {
                    db.prepare('UPDATE users SET balance = ?, commission_balance = commission_balance + ? WHERE id = ?').run(newBalance, commissionAmount, referrerId);
                }
            }
        }
        currentUserId = referrerId;
    }
}

function toPublicDeposit(row) {
    return {
        id: row.id,
        userId: row.user_id,
        userName: row.user_name,
        userPhone: row.user_phone,
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

router.post('/', requireAuth, (req, res) => {
    if (req.user.deposits_blocked) return res.status(403).json({ error: 'Deposits are disabled for this account.' });
    const { amount, senderPhone, senderName, paymentProof } = req.body || {};
    const method = String(req.body?.method || '').trim().toLowerCase();
    if (!['mtn', 'airtel'].includes(method) || !amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid MTN or Airtel method and a positive amount are required.' });
    const settings = getCountrySetting(db, req.user.country_code, 'deposit') || {};
    const methodSettings = settings[String(method).toLowerCase()] || {};
    const minimum = Number(methodSettings.min ?? settings.minimumAmount ?? 0);
    const maximum = Number(methodSettings.max ?? settings.maximumAmount ?? Number.MAX_SAFE_INTEGER);
    if (settings.enabled === false || methodSettings.enabled === false) return res.status(403).json({ error: 'Deposits are currently disabled.' });
    const currency = getCountry(req.user.country_code)?.currency || 'RWF';
    if (Number(amount) < minimum) return res.status(400).json({ error: `Minimum deposit is ${minimum.toLocaleString()} ${currency}.` });
    if (Number(amount) > maximum) return res.status(400).json({ error: `Maximum deposit is ${maximum.toLocaleString()} ${currency}.` });
    if (settings.proofRequired && !String(paymentProof || '').trim()) return res.status(400).json({ error: 'Enter the transaction reference from your payment receipt.' });
    if (!senderPhone || !isValidCountryPhone(req.user.country_code, senderPhone)) {
        return res.status(400).json({ error: req.user.language === 'rw' && req.user.country_code === 'RW' ? PHONE_ERROR_RW : 'Enter a valid phone number for your registered country.' });
    }

    const normalizedAmount = Math.round(Number(amount));
    const id = uuid();
    db.prepare(
        "INSERT INTO deposits (id, user_id, method, amount, sender_phone, sender_name, payment_proof, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
    ).run(id, req.user.id, method, normalizedAmount, senderPhone || null, senderName || null, paymentProof || null);

    notifyUser(req.user.id, { type: 'deposit_submitted', title: 'Deposit submitted', message: `Your ${method.toUpperCase()} deposit is waiting for verification.`, relatedType: 'deposit', relatedId: id, eventKey: `deposit:${id}:submitted:user` });
    notifyAdmins({ type: 'deposit_pending', title: 'New deposit to verify', message: `${method.toUpperCase()} deposit of ${currency} ${normalizedAmount.toLocaleString()} is waiting for review.`, relatedType: 'deposit', relatedId: id, eventKey: `deposit:${id}:submitted:admin` });

    res.status(201).json({ deposit: toPublicDeposit(db.prepare('SELECT * FROM deposits WHERE id = ?').get(id)), status: 'submitted for verification' });
});

router.get('/mine', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM deposits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ deposits: rows.map(toPublicDeposit) });
});

router.get('/', requireAdmin, (req, res) => {
    const status = String(req.query.status || '').trim();
    const where = status ? 'WHERE d.status = ?' : '';
    const params = status ? [status] : [];
    const rows = db.prepare(`
        SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone
        FROM deposits d
        JOIN users u ON u.id = d.user_id
        ${where}
        ORDER BY d.created_at DESC
    `).all(...params);
    res.json({ deposits: rows.map(toPublicDeposit) });
});

router.post('/:id/approve', requireAdmin, (req, res) => {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
    if (deposit.status !== 'pending') return res.status(409).json({ error: 'This deposit has already been reviewed.' });

    db.exec('BEGIN IMMEDIATE');
    try {
        const currentDeposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(deposit.id);
        if (!currentDeposit || currentDeposit.status !== 'pending') {
            db.exec('ROLLBACK');
            return res.status(409).json({ error: 'This deposit has already been reviewed.' });
        }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(deposit.user_id);
        const newBalance = user.balance + deposit.amount;
        db.prepare('UPDATE users SET balance = ?, deposited_balance = deposited_balance + ? WHERE id = ?').run(newBalance, deposit.amount, user.id);
        db.prepare("UPDATE deposits SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, deposit.id);
        db.prepare(
            "INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, 'deposit', ?, ?, ?, 'Deposit approved', ?, ?)",
        ).run(uuid(), user.id, deposit.amount, user.balance, newBalance, deposit.id, req.user.id);
        const pendingBonus = db.prepare("SELECT * FROM user_bonuses WHERE user_id = ? AND status = 'PENDING' AND deposit_required = 1").get(user.id);
        const bonusSetting = getCountrySetting(db, user.country_code, 'welcomeBonus') || {};
        const qualifyingDeposit = Number(deposit.amount) >= Number(bonusSetting.minimumDeposit || 0);
        const hasProduct = pendingBonus ? !!db.prepare("SELECT 1 FROM product_purchases WHERE user_id = ? AND status = 'completed' LIMIT 1").get(user.id) : false;
        if (pendingBonus && qualifyingDeposit && (!pendingBonus.product_required || hasProduct)) {
            db.prepare("UPDATE user_bonuses SET status = 'UNLOCKED', unlocked_at = datetime('now') WHERE id = ?").run(pendingBonus.id);
            db.prepare("UPDATE reward_transactions SET status = 'completed', previous_balance = ?, new_balance = ? WHERE user_id = ? AND type = 'welcome_bonus' AND reference_id = ?").run(user.balance, user.balance + pendingBonus.amount, user.id, pendingBonus.id);
        }
        creditReferralCommissions(user.id, deposit.amount, deposit.id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Unable to approve deposit.' });
    }

    logAudit({ adminId: req.user.id, action: 'deposit_approved', target: deposit.id, amount: deposit.amount, previousValue: { status: 'pending' }, newValue: { status: 'approved' } });
    notifyUser(deposit.user_id, { type: 'deposit_approved', title: 'Deposit approved', message: `Your ${deposit.method.toUpperCase()} deposit was approved.`, relatedType: 'deposit', relatedId: deposit.id, eventKey: `deposit:${deposit.id}:approved:user` });
    res.json({ deposit: toPublicDeposit(db.prepare('SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(deposit.id)) });
});

router.post('/:id/reject', requireAdmin, (req, res) => {
    const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found.' });
    if (deposit.status !== 'pending') return res.status(409).json({ error: 'This deposit has already been reviewed.' });

    db.prepare("UPDATE deposits SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, deposit.id);
    logAudit({ adminId: req.user.id, action: 'deposit_rejected', target: deposit.id, reason: req.body?.reason, previousValue: { status: 'pending' }, newValue: { status: 'rejected' } });
    notifyUser(deposit.user_id, { type: 'deposit_rejected', title: 'Deposit rejected', message: `Your ${deposit.method.toUpperCase()} deposit was rejected.`, relatedType: 'deposit', relatedId: deposit.id, eventKey: `deposit:${deposit.id}:rejected:user` });
    res.json({ deposit: toPublicDeposit(db.prepare('SELECT d.*, u.full_name AS user_name, u.phone_number AS user_phone FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?').get(deposit.id)) });
});

module.exports = { router };
