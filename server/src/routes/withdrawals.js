// Withdrawal requests reserve eligible funds immediately; Admin approval confirms the payout,
// while rejection refunds the exact reserved buckets.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { notifyUser, notifyAdmins } = require('../utils/notifications');
const { getCountry, getCountrySetting, isValidCountryPhone } = require('../utils/countries');

const router = express.Router();
const SUPPORTED_WITHDRAWAL_METHODS = new Set(['mtn', 'airtel', 'bank']);

const INSUFFICIENT_ELIGIBLE_BALANCE_ERROR = 'Your deposited balance cannot be withdrawn. Only eligible bonus, commission, daily income, and task income can be withdrawn.';
const PHONE_ERROR_RW = 'Numero ya telefoni igomba kuba imibare 10 kandi igatangira kuri 07.';
const INSUFFICIENT_ELIGIBLE_BALANCE_ERROR_RW = 'Amafaranga washyizemo ntashobora kubikuzwa. Habikuzwa gusa bonus, commission, daily income n\'amafaranga ya task yemerewe kubikuzwa.';
const localizedError = (req, english, kinyarwanda) => req.user.language === 'rw' ? kinyarwanda : english;

function isWithdrawalWindowOpen(availability, now = new Date()) {
    if (!availability?.enabled) return true;
    const timeZone = availability.timeZone || 'Africa/Kigali';
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    const currentDay = values.weekday;
    const currentMinute = Number(values.hour) * 60 + Number(values.minute);
    const openMinute = Number(availability.openHour ?? 0) * 60;
    const closeMinute = Number(availability.closeHour ?? 24) * 60;
    const days = Array.isArray(availability.days) ? availability.days : [];
    if (openMinute <= closeMinute) return days.includes(currentDay) && currentMinute >= openMinute && currentMinute < closeMinute;

    const dayIndex = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].indexOf(currentDay);
    const previousDay = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][(dayIndex + 6) % 7];
    return (days.includes(currentDay) && currentMinute >= openMinute) ||
        (days.includes(previousDay) && currentMinute < closeMinute);
}

// Deposited/investment principal is never withdrawable -- only unlocked bonus plus the
// commission/daily-income/task balances count toward what a user may withdraw.
function getEligibleBonus(userId) {
    const bonus = db.prepare('SELECT * FROM user_bonuses WHERE user_id = ?').get(userId);
    if (!bonus || bonus.status !== 'UNLOCKED') return 0;
    if (bonus.expires_at && new Date(bonus.expires_at) <= new Date()) return 0;
    const user = db.prepare('SELECT country_code FROM users WHERE id = ?').get(userId);
    const setting = getCountrySetting(db, user?.country_code, 'welcomeBonus') || {};
    if (setting.withdrawable === false) return 0;
    const hasPurchasedProduct = db.prepare("SELECT 1 FROM product_purchases WHERE user_id = ? AND status = 'completed' LIMIT 1").get(userId);
    if (!hasPurchasedProduct) return 0;
    return Number(bonus.amount || 0);
}

function getWithdrawableAmount(user) {
    return getEligibleBonus(user.id)
        + Number(user.commission_balance || 0)
        + Number(user.daily_income_balance || 0)
        + Number(user.task_balance || 0);
}

function toPublicWithdrawal(row) {
    return {
        id: row.id,
        userId: row.user_id,
        userName: row.user_name,
        userPhone: row.user_phone,
        userCountryCode: row.user_country_code || null,
        currency: getCountry(row.user_country_code)?.currency || null,
        method: row.method,
        accountHolderName: row.account_holder_name,
        mobileMoneyNumber: row.mobile_money_number,
        bankName: row.bank_name || '',
        bankAccountNumber: row.bank_account_number || '',
        amount: row.amount,
        fee: row.fee,
        receivedAmount: row.received_amount,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
    };
}

function toPublicAccount(row) {
    if (!row) return null;
    return {
        method: row.method,
        accountHolderName: row.account_holder_name,
        mobileMoneyNumber: row.mobile_money_number,
        bankName: row.bank_name || '',
        bankAccountNumber: row.bank_account_number || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

router.get('/account', requireAuth, (req, res) => {
    const account = db.prepare('SELECT * FROM withdrawal_accounts WHERE user_id = ?').get(req.user.id);
    res.json({ account: toPublicAccount(account) });
});

router.put('/account', requireAuth, (req, res) => {
    const method = String(req.body?.method || '').trim().toLowerCase();
    const accountHolderName = String(req.body?.accountHolderName || '').trim();
    const mobileMoneyNumber = String(req.body?.mobileMoneyNumber || '').replace(/\s+/g, '');
    const bankName = String(req.body?.bankName || '').trim();
    const bankAccountNumber = String(req.body?.bankAccountNumber || '').replace(/\s+/g, '');
    const countrySettings = getCountrySetting(db, req.user.country_code, 'withdraw') || {};
    if (!SUPPORTED_WITHDRAWAL_METHODS.has(method) || !accountHolderName) {
        return res.status(400).json({ error: 'Choose a supported account type and enter the account holder name.' });
    }
    if (!countrySettings[method] || countrySettings[method].enabled === false) {
        return res.status(400).json({ error: 'This withdrawal method is not enabled in your country.' });
    }
    if (method === 'bank' && (!bankName || !/^[A-Za-z0-9-]{5,34}$/.test(bankAccountNumber))) {
        return res.status(400).json({ error: 'Enter a bank name and a valid account number (5-34 letters or digits).' });
    }
    if (method !== 'bank' && !isValidCountryPhone(req.user.country_code, mobileMoneyNumber)) {
        return res.status(400).json({ error: 'Enter a valid mobile money number for your registered country.' });
    }
    const existing = db.prepare('SELECT id FROM withdrawal_accounts WHERE user_id = ?').get(req.user.id);
    if (existing) {
        db.prepare("UPDATE withdrawal_accounts SET method = ?, account_holder_name = ?, mobile_money_number = ?, bank_name = ?, bank_account_number = ?, updated_at = datetime('now') WHERE user_id = ?")
            .run(method, accountHolderName, method === 'bank' ? '' : mobileMoneyNumber, method === 'bank' ? bankName : null, method === 'bank' ? bankAccountNumber : null, req.user.id);
    } else {
        db.prepare('INSERT INTO withdrawal_accounts (id, user_id, method, account_holder_name, mobile_money_number, bank_name, bank_account_number) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(uuid(), req.user.id, method, accountHolderName, method === 'bank' ? '' : mobileMoneyNumber, method === 'bank' ? bankName : null, method === 'bank' ? bankAccountNumber : null);
    }
    res.json({ account: toPublicAccount(db.prepare('SELECT * FROM withdrawal_accounts WHERE user_id = ?').get(req.user.id)) });
});

router.get('/eligible', requireAuth, (req, res) => {
    res.json({ withdrawable: getWithdrawableAmount(req.user) });
});

router.post('/', requireAuth, (req, res) => {
    if (req.user.withdrawals_blocked) return res.status(403).json({ error: 'Withdrawals are disabled for this account.' });
    const { amount } = req.body || {};
    const boundAccount = db.prepare('SELECT * FROM withdrawal_accounts WHERE user_id = ?').get(req.user.id);
    if (!boundAccount) return res.status(400).json({ error: 'Bind a withdrawal account in Me before requesting a payout.' });
    const method = boundAccount.method;
    const accountHolderName = String(boundAccount.account_holder_name || '').trim();
    const mobileMoneyNumber = boundAccount.mobile_money_number || '';
    const bankName = boundAccount.bank_name || '';
    const bankAccountNumber = boundAccount.bank_account_number || '';
    const settings = getCountrySetting(db, req.user.country_code, 'withdraw') || {};
    if (!SUPPORTED_WITHDRAWAL_METHODS.has(method) || !settings[method] || settings[method].enabled === false) {
        return res.status(403).json({ error: 'Your saved withdrawal method is not enabled for your country.' });
    }
    if ((method === 'bank'
        ? (!bankName || !/^[A-Za-z0-9-]{5,34}$/.test(bankAccountNumber))
        : !isValidCountryPhone(req.user.country_code, String(mobileMoneyNumber)))) {
        return res.status(400).json({ error: 'Your saved withdrawal account is invalid. Update it in Me before requesting a payout.' });
    }
    if (!accountHolderName) return res.status(400).json({ error: 'Your account must have a full name before requesting a withdrawal.' });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'Enter a positive withdrawal amount.' });
    if (!isWithdrawalWindowOpen(settings.availability)) {
        return res.status(403).json({ error: 'Withdrawals are currently outside the configured cash-out hours.' });
    }
    const requestedAmount = Math.round(Number(amount));
    const methodSettings = settings[method] || {};
    if (methodSettings.enabled === false) return res.status(403).json({ error: `${method.toUpperCase()} withdrawals are currently disabled.` });
    const minimum = Number(methodSettings.min ?? settings.minAmount ?? 0);
    const maximum = Number(methodSettings.max ?? settings.maxAmount ?? Number.MAX_SAFE_INTEGER);
    if (settings.enabled === false) return res.status(403).json({ error: 'Withdrawals are currently disabled.' });
    const currency = getCountry(req.user.country_code)?.currency || 'RWF';
    if (requestedAmount < minimum) return res.status(400).json({ error: `Minimum withdrawal is ${minimum.toLocaleString()} ${currency}.` });
    if (requestedAmount > maximum) return res.status(400).json({ error: `Maximum withdrawal is ${maximum.toLocaleString()} ${currency}.` });
    const feeAmount = Math.round(requestedAmount * Number(settings.feePercent || 0) / 100);
    const receivedAmount = Math.max(0, requestedAmount - feeAmount);
    const id = uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        const withdrawable = getWithdrawableAmount(user);
        if (requestedAmount > withdrawable) { db.exec('ROLLBACK'); return res.status(400).json({ error: localizedError(req, INSUFFICIENT_ELIGIBLE_BALANCE_ERROR, INSUFFICIENT_ELIGIBLE_BALANCE_ERROR_RW) }); }
        if (Number(user.balance) - requestedAmount < Number(settings.minimumBalance || 0)) { db.exec('ROLLBACK'); return res.status(400).json({ error: `You must keep at least ${Number(settings.minimumBalance || 0).toLocaleString()} ${currency} in your balance.` }); }

        let remaining = requestedAmount;
        const take = (available) => { const used = Math.min(Number(available || 0), remaining); remaining -= used; return used; };
        const commissionReserved = take(user.commission_balance);
        const dailyIncomeReserved = take(user.daily_income_balance);
        const taskReserved = take(user.task_balance);
        const bonusReserved = take(getEligibleBonus(user.id));
        const newBalance = Number(user.balance) - requestedAmount;
        db.prepare('UPDATE users SET balance = ?, commission_balance = commission_balance - ?, daily_income_balance = daily_income_balance - ?, task_balance = task_balance - ?, bonus_balance = bonus_balance - ? WHERE id = ?')
            .run(newBalance, commissionReserved, dailyIncomeReserved, taskReserved, bonusReserved, user.id);
        if (bonusReserved > 0) db.prepare("UPDATE user_bonuses SET amount = amount - ? WHERE user_id = ?").run(bonusReserved, user.id);
        db.prepare(
            "INSERT INTO withdrawals (id, user_id, method, account_holder_name, mobile_money_number, bank_name, bank_account_number, amount, fee, received_amount, commission_reserved, daily_income_reserved, task_reserved, bonus_reserved, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        ).run(id, req.user.id, method, accountHolderName, mobileMoneyNumber, method === 'bank' ? bankName : null, method === 'bank' ? bankAccountNumber : null, requestedAmount, feeAmount, receivedAmount, commissionReserved, dailyIncomeReserved, taskReserved, bonusReserved);
        db.prepare("INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, 'withdrawal', ?, ?, ?, 'Withdrawal reserved pending approval', ?, 'user')")
            .run(uuid(), user.id, -requestedAmount, user.balance, newBalance, id);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Unable to submit withdrawal request.' });
    }

    res.status(201).json({ withdrawal: toPublicWithdrawal(db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id)), status: 'submitted for approval' });
    notifyAdmins({ type: 'withdrawal_pending', title: 'New withdrawal to verify', message: `${method.toUpperCase()} withdrawal of ${currency} ${requestedAmount.toLocaleString()} is waiting for review.`, relatedType: 'withdrawal', relatedId: id, eventKey: `withdrawal:${id}:submitted:admin` });
    notifyUser(req.user.id, { type: 'withdrawal_submitted', title: 'Withdrawal submitted', message: 'Your withdrawal request is pending approval.', relatedType: 'withdrawal', relatedId: id, eventKey: `withdrawal:${id}:submitted:user` });
});

router.get('/mine', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ withdrawals: rows.map(toPublicWithdrawal) });
});

router.get('/', requireAdmin, (req, res) => {
    const status = String(req.query.status || '').trim();
    const where = status ? 'WHERE w.status = ?' : '';
    const params = status ? [status] : [];
    const rows = db.prepare(`
        SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone, u.country_code AS user_country_code
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
        ${where}
        ORDER BY w.created_at DESC
    `).all(...params);
    res.json({ withdrawals: rows.map(toPublicWithdrawal) });
});

router.post('/:id/approve', requireAdmin, (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found.' }); }
    if (withdrawal.status !== 'pending') { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This withdrawal has already been reviewed.' }); }

    db.prepare("UPDATE withdrawals SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, withdrawal.id);

    logAudit({ adminId: req.user.id, action: 'withdrawal_approved', target: withdrawal.id, amount: withdrawal.amount, previousValue: { status: 'pending' }, newValue: { status: 'approved' } });
    db.exec('COMMIT');
    notifyUser(withdrawal.user_id, { type: 'withdrawal_approved', title: 'Withdrawal approved', message: 'Your withdrawal request was approved.', relatedType: 'withdrawal', relatedId: withdrawal.id, eventKey: `withdrawal:${withdrawal.id}:approved:user` });
    res.json({ withdrawal: toPublicWithdrawal(db.prepare('SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(withdrawal.id)) });
});

router.post('/:id/reject', requireAdmin, (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Withdrawal not found.' }); }
    if (withdrawal.status !== 'pending') { db.exec('ROLLBACK'); return res.status(409).json({ error: 'This withdrawal has already been reviewed.' }); }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(withdrawal.user_id);
    const reservedTotal = Number(withdrawal.commission_reserved || 0)
        + Number(withdrawal.daily_income_reserved || 0)
        + Number(withdrawal.task_reserved || 0)
        + Number(withdrawal.bonus_reserved || 0);
    if (reservedTotal !== Number(withdrawal.amount)) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Withdrawal reservation mismatch. Contact support.' });
    }
    const restoredBalance = Number(user.balance) + Number(withdrawal.amount);
    db.prepare('UPDATE users SET balance = ?, commission_balance = commission_balance + ?, daily_income_balance = daily_income_balance + ?, task_balance = task_balance + ?, bonus_balance = bonus_balance + ? WHERE id = ?')
        .run(restoredBalance, withdrawal.commission_reserved, withdrawal.daily_income_reserved, withdrawal.task_reserved, withdrawal.bonus_reserved, user.id);
    if (withdrawal.bonus_reserved > 0) db.prepare('UPDATE user_bonuses SET amount = amount + ? WHERE user_id = ?').run(withdrawal.bonus_reserved, user.id);
    db.prepare("UPDATE withdrawals SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, withdrawal.id);
    db.prepare("INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, 'adjustment', ?, ?, ?, 'Withdrawal reservation refunded', ?, ?)")
        .run(uuid(), user.id, withdrawal.amount, user.balance, restoredBalance, withdrawal.id, req.user.id);
    logAudit({ adminId: req.user.id, action: 'withdrawal_rejected', target: withdrawal.id, reason: req.body?.reason, previousValue: { status: 'pending' }, newValue: { status: 'rejected' } });
    db.exec('COMMIT');
    notifyUser(withdrawal.user_id, { type: 'withdrawal_rejected', title: 'Withdrawal rejected', message: 'Your withdrawal request was rejected and the reserved amount was returned.', relatedType: 'withdrawal', relatedId: withdrawal.id, eventKey: `withdrawal:${withdrawal.id}:rejected:user` });
    res.json({ withdrawal: toPublicWithdrawal(db.prepare('SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(withdrawal.id)) });
});

router.post('/:id/mark-paid', requireAdmin, (req, res) => {
    const withdrawal = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(req.params.id);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (withdrawal.status !== 'approved') return res.status(409).json({ error: 'Only approved withdrawals can be marked as paid.' });

    db.prepare("UPDATE withdrawals SET status = 'paid', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.user.id, withdrawal.id);
    logAudit({ adminId: req.user.id, action: 'withdrawal_marked_paid', target: withdrawal.id, previousValue: { status: 'approved' }, newValue: { status: 'paid' } });
    res.json({ withdrawal: toPublicWithdrawal(db.prepare('SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?').get(withdrawal.id)) });
});

module.exports = { router };
