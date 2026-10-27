const express = require('express');
const { pool, transaction, uuid, getCountrySetting } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { createNotification, notifyAdmins } = require('../notifications');
const { getCountry, isValidCountryPhone } = require('../../utils/countries');

const router = express.Router();
const supportedMethods = new Set(['mtn', 'airtel', 'bank']);
const insufficientBalanceError = 'Your deposited balance cannot be withdrawn. Only eligible bonus, commission, daily income, and task income can be withdrawn.';
const insufficientBalanceErrorRw = 'Amafaranga washyizemo ntashobora kubikuzwa. Habikuzwa gusa bonus, commission, daily income n\'amafaranga ya task yemerewe kubikuzwa.';
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
    return (days.includes(currentDay) && currentMinute >= openMinute) || (days.includes(previousDay) && currentMinute < closeMinute);
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

async function getEligibleBonusDetails(client, userId, countryCode, lock = false) {
    const { rows } = await client.query(
        `SELECT * FROM user_bonuses
         WHERE user_id = $1 AND status = 'UNLOCKED'
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY created_at DESC LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
        [userId],
    );
    const bonus = rows[0];
    if (!bonus) return null;
    const setting = await getCountrySetting(client, countryCode, 'welcomeBonus') || {};
    if (setting.withdrawable === false) return null;
    const purchase = await client.query(
        "SELECT 1 FROM product_purchases WHERE user_id = $1 AND status = 'completed' LIMIT 1",
        [userId],
    );
    return purchase.rowCount ? bonus : null;
}

async function getEligibleBonus(client, userId, countryCode) {
    const bonus = await getEligibleBonusDetails(client, userId, countryCode);
    return Number(bonus?.amount || 0);
}

async function getWithdrawableAmount(client, user, eligibleBonus = undefined) {
    const bonus = eligibleBonus === undefined
        ? await getEligibleBonus(client, user.id, user.country_code)
        : Number(eligibleBonus?.amount || 0);
    return bonus
        + Number(user.commission_balance || 0)
        + Number(user.daily_income_balance || 0)
        + Number(user.task_balance || 0);
}

async function readWithdrawal(client, id, joinUser = false) {
    const query = joinUser
        ? `SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone
           FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = $1`
        : 'SELECT * FROM withdrawals WHERE id = $1';
    const { rows } = await client.query(query, [id]);
    return rows[0] || null;
}

router.get('/account', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM withdrawal_accounts WHERE user_id = $1', [req.user.id]);
        return res.json({ account: toPublicAccount(rows[0]) });
    } catch (error) { return next(error); }
});

router.put('/account', requireAuth, async (req, res, next) => {
    try {
        const method = String(req.body?.method || '').trim().toLowerCase();
        const accountHolderName = String(req.body?.accountHolderName || '').trim();
        const mobileMoneyNumber = String(req.body?.mobileMoneyNumber || '').replace(/\s+/g, '');
        const bankName = String(req.body?.bankName || '').trim();
        const bankAccountNumber = String(req.body?.bankAccountNumber || '').replace(/\s+/g, '');
        const countrySettings = await getCountrySetting(pool, req.user.country_code, 'withdraw') || {};
        if (!supportedMethods.has(method) || !accountHolderName) {
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
        const { rows } = await pool.query(
            `INSERT INTO withdrawal_accounts
             (id, user_id, method, account_holder_name, mobile_money_number, bank_name, bank_account_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (user_id) DO UPDATE SET
                method = EXCLUDED.method,
                account_holder_name = EXCLUDED.account_holder_name,
                mobile_money_number = EXCLUDED.mobile_money_number,
                bank_name = EXCLUDED.bank_name,
                bank_account_number = EXCLUDED.bank_account_number,
                updated_at = CURRENT_TIMESTAMP
             RETURNING *`,
            [
                uuid(),
                req.user.id,
                method,
                accountHolderName,
                method === 'bank' ? '' : mobileMoneyNumber,
                method === 'bank' ? bankName : null,
                method === 'bank' ? bankAccountNumber : null,
            ],
        );
        return res.json({ account: toPublicAccount(rows[0]) });
    } catch (error) { return next(error); }
});

router.get('/eligible', requireAuth, async (req, res, next) => {
    try {
        return res.json({ withdrawable: await getWithdrawableAmount(pool, req.user) });
    } catch (error) { return next(error); }
});

router.post('/', requireAuth, async (req, res, next) => {
    try {
        if (req.user.withdrawals_blocked) return res.status(403).json({ error: 'Withdrawals are disabled for this account.' });
        const { amount } = req.body || {};
        const accountResult = await pool.query('SELECT * FROM withdrawal_accounts WHERE user_id = $1', [req.user.id]);
        const boundAccount = accountResult.rows[0];
        if (!boundAccount) return res.status(400).json({ error: 'Bind a withdrawal account in Me before requesting a payout.' });
        const { method } = boundAccount;
        const accountHolderName = String(boundAccount.account_holder_name || '').trim();
        const mobileMoneyNumber = boundAccount.mobile_money_number || '';
        const bankName = boundAccount.bank_name || '';
        const bankAccountNumber = boundAccount.bank_account_number || '';
        const settings = await getCountrySetting(pool, req.user.country_code, 'withdraw') || {};
        if (!supportedMethods.has(method) || !settings[method] || settings[method].enabled === false) {
            return res.status(403).json({ error: 'Your saved withdrawal method is not enabled for your country.' });
        }
        if ((method === 'bank'
            ? (!bankName || !/^[A-Za-z0-9-]{5,34}$/.test(bankAccountNumber))
            : !isValidCountryPhone(req.user.country_code, String(mobileMoneyNumber)))) {
            return res.status(400).json({ error: 'Your saved withdrawal account is invalid. Update it in Me before requesting a payout.' });
        }
        if (!accountHolderName) return res.status(400).json({ error: 'Your account must have a full name before requesting a withdrawal.' });
        const numericAmount = Number(amount);
        const requestedAmount = Math.round(numericAmount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0 ||
            !Number.isSafeInteger(requestedAmount) || requestedAmount <= 0 || requestedAmount > 2147483647) {
            return res.status(400).json({ error: 'Enter a positive withdrawal amount.' });
        }
        if (!isWithdrawalWindowOpen(settings.availability)) return res.status(403).json({ error: 'Withdrawals are currently outside the configured cash-out hours.' });
        const methodSettings = settings[method] || {};
        const minimum = Number(methodSettings.min ?? settings.minAmount ?? 0);
        const maximum = Number(methodSettings.max ?? settings.maxAmount ?? Number.MAX_SAFE_INTEGER);
        if (settings.enabled === false) return res.status(403).json({ error: 'Withdrawals are currently disabled.' });
        const currency = getCountry(req.user.country_code)?.currency || 'RWF';
        if (requestedAmount < minimum) return res.status(400).json({ error: `Minimum withdrawal is ${minimum.toLocaleString()} ${currency}.` });
        if (requestedAmount > maximum) return res.status(400).json({ error: `Maximum withdrawal is ${maximum.toLocaleString()} ${currency}.` });
        const feeAmount = Math.round(requestedAmount * Number(settings.feePercent || 0) / 100);
        const receivedAmount = Math.max(0, requestedAmount - feeAmount);
        const id = uuid();
        const withdrawal = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
            const user = rows[0];
            if (!user || user.status !== 'Active' || user.withdrawals_blocked) {
                return { error: 'Withdrawals are disabled for this account.', status: 403 };
            }
            const bonus = await getEligibleBonusDetails(client, user.id, user.country_code, true);
            const available = await getWithdrawableAmount(client, user, bonus);
            if (requestedAmount > available) {
                return { error: localizedError(req, insufficientBalanceError, insufficientBalanceErrorRw), status: 400 };
            }
            if (Number(user.balance) - requestedAmount < Number(settings.minimumBalance || 0)) {
                return { error: `You must keep at least ${Number(settings.minimumBalance || 0).toLocaleString()} ${currency} in your balance.`, status: 400 };
            }
            let remaining = requestedAmount;
            const take = (value) => {
                const used = Math.min(Number(value || 0), remaining);
                remaining -= used;
                return used;
            };
            const commissionReserved = take(user.commission_balance);
            const dailyIncomeReserved = take(user.daily_income_balance);
            const taskReserved = take(user.task_balance);
            const bonusReserved = take(bonus?.amount || 0);
            if (remaining !== 0) throw new Error('Eligible withdrawal balance changed during reservation.');
            const previousBalance = Number(user.balance);
            const newBalance = previousBalance - requestedAmount;
            await client.query(
                `UPDATE users SET balance = $1, commission_balance = commission_balance - $2,
                 daily_income_balance = daily_income_balance - $3, task_balance = task_balance - $4,
                 bonus_balance = bonus_balance - $5 WHERE id = $6`,
                [newBalance, commissionReserved, dailyIncomeReserved, taskReserved, bonusReserved, user.id],
            );
            if (bonusReserved > 0) {
                await client.query(
                    'UPDATE user_bonuses SET amount = amount - $1 WHERE id = $2',
                    [bonusReserved, bonus.id],
                );
            }
            await client.query(
                `INSERT INTO withdrawals
                 (id, user_id, method, account_holder_name, mobile_money_number, bank_name, bank_account_number,
                  amount, fee, received_amount, commission_reserved, daily_income_reserved, task_reserved, bonus_reserved, bonus_id, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')`,
                [
                    id, user.id, method, accountHolderName, mobileMoneyNumber,
                    method === 'bank' ? bankName : null,
                    method === 'bank' ? bankAccountNumber : null,
                    requestedAmount, feeAmount, receivedAmount,
                    commissionReserved, dailyIncomeReserved, taskReserved, bonusReserved, bonusReserved > 0 ? bonus.id : null,
                ],
            );
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'withdrawal', $3, $4, $5, 'Withdrawal reserved pending approval', $6, 'user')`,
                [uuid(), user.id, -requestedAmount, previousBalance, newBalance, id],
            );
            await notifyAdmins(client, {
                type: 'withdrawal_pending',
                title: 'New withdrawal to verify',
                message: `${method.toUpperCase()} withdrawal of ${currency} ${requestedAmount.toLocaleString()} is waiting for review.`,
                relatedType: 'withdrawal',
                relatedId: id,
                eventKey: `withdrawal:${id}:submitted`,
            });
            await createNotification(client, {
                recipientType: 'user',
                recipientId: user.id,
                type: 'withdrawal_submitted',
                title: 'Withdrawal submitted',
                message: 'Your withdrawal request is pending approval.',
                relatedType: 'withdrawal',
                relatedId: id,
                eventKey: `withdrawal:${id}:submitted:user`,
            });
            const { rows: created } = await client.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
            return { withdrawal: created[0] };
        });
        if (withdrawal.error) return res.status(withdrawal.status).json({ error: withdrawal.error });
        return res.status(201).json({ withdrawal: toPublicWithdrawal(withdrawal.withdrawal), status: 'submitted for approval' });
    } catch (error) { return next(error); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
        return res.json({ withdrawals: rows.map(toPublicWithdrawal) });
    } catch (error) { return next(error); }
});

router.get('/', requireAdmin, async (req, res, next) => {
    try {
        const status = String(req.query.status || '').trim();
        const { rows } = await pool.query(`
            SELECT w.*, u.full_name AS user_name, u.phone_number AS user_phone, u.country_code AS user_country_code
            FROM withdrawals w JOIN users u ON u.id = w.user_id
            ${status ? 'WHERE w.status = $1' : ''}
            ORDER BY w.created_at DESC
        `, status ? [status] : []);
        return res.json({ withdrawals: rows.map(toPublicWithdrawal) });
    } catch (error) { return next(error); }
});

router.post('/:id/approve', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [req.params.id]);
            const withdrawal = rows[0];
            if (!withdrawal) return { error: 'Withdrawal not found.', status: 404 };
            if (withdrawal.status !== 'pending') return { error: 'This withdrawal has already been reviewed.', status: 409 };
            await client.query(
                "UPDATE withdrawals SET status = 'approved', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2",
                [req.user.id, withdrawal.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'withdrawal_approved',
                target: withdrawal.id,
                amount: withdrawal.amount,
                previousValue: { status: 'pending' },
                newValue: { status: 'approved' },
            });
            await createNotification(client, {
                recipientType: 'user',
                recipientId: withdrawal.user_id,
                type: 'withdrawal_approved',
                title: 'Withdrawal approved',
                message: 'Your withdrawal request was approved.',
                relatedType: 'withdrawal',
                relatedId: withdrawal.id,
                eventKey: `withdrawal:${withdrawal.id}:approved:user`,
            });
            return { withdrawal: await readWithdrawal(client, withdrawal.id, true) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ withdrawal: toPublicWithdrawal(result.withdrawal) });
    } catch (error) { return next(error); }
});

router.post('/:id/reject', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [req.params.id]);
            const withdrawal = rows[0];
            if (!withdrawal) return { error: 'Withdrawal not found.', status: 404 };
            if (withdrawal.status !== 'pending') return { error: 'This withdrawal has already been reviewed.', status: 409 };
            const { rows: users } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [withdrawal.user_id]);
            const user = users[0];
            if (!user) throw new Error('Withdrawal is linked to a missing user.');
            const reservedTotal = Number(withdrawal.commission_reserved || 0)
                + Number(withdrawal.daily_income_reserved || 0)
                + Number(withdrawal.task_reserved || 0)
                + Number(withdrawal.bonus_reserved || 0);
            if (reservedTotal !== Number(withdrawal.amount)) throw new Error('Withdrawal reservation mismatch. Contact support.');
            const previousBalance = Number(user.balance);
            const newBalance = previousBalance + Number(withdrawal.amount);
            await client.query(
                `UPDATE users SET balance = $1, commission_balance = commission_balance + $2,
                 daily_income_balance = daily_income_balance + $3, task_balance = task_balance + $4,
                 bonus_balance = bonus_balance + $5 WHERE id = $6`,
                [
                    newBalance, withdrawal.commission_reserved, withdrawal.daily_income_reserved,
                    withdrawal.task_reserved, withdrawal.bonus_reserved, user.id,
                ],
            );
            if (Number(withdrawal.bonus_reserved) > 0) {
                const restoredBonus = await client.query(
                    'UPDATE user_bonuses SET amount = amount + $1 WHERE id = $2 AND user_id = $3 RETURNING id',
                    [withdrawal.bonus_reserved, withdrawal.bonus_id, user.id],
                );
                if (!restoredBonus.rowCount) throw new Error('Reserved withdrawal bonus is missing. Contact support.');
            }
            await client.query(
                "UPDATE withdrawals SET status = 'rejected', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2",
                [req.user.id, withdrawal.id],
            );
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'adjustment', $3, $4, $5, 'Withdrawal reservation refunded', $6, $7)`,
                [uuid(), user.id, withdrawal.amount, previousBalance, newBalance, withdrawal.id, req.user.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'withdrawal_rejected',
                target: withdrawal.id,
                reason: req.body?.reason,
                previousValue: { status: 'pending' },
                newValue: { status: 'rejected' },
            });
            await createNotification(client, {
                recipientType: 'user',
                recipientId: withdrawal.user_id,
                type: 'withdrawal_rejected',
                title: 'Withdrawal rejected',
                message: 'Your withdrawal request was rejected and the reserved amount was returned.',
                relatedType: 'withdrawal',
                relatedId: withdrawal.id,
                eventKey: `withdrawal:${withdrawal.id}:rejected:user`,
            });
            return { withdrawal: await readWithdrawal(client, withdrawal.id, true) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ withdrawal: toPublicWithdrawal(result.withdrawal) });
    } catch (error) { return next(error); }
});

router.post('/:id/mark-paid', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [req.params.id]);
            const withdrawal = rows[0];
            if (!withdrawal) return { error: 'Withdrawal not found.', status: 404 };
            if (withdrawal.status !== 'approved') return { error: 'Only approved withdrawals can be marked as paid.', status: 409 };
            await client.query(
                "UPDATE withdrawals SET status = 'paid', reviewed_by = $1, reviewed_at = CURRENT_TIMESTAMP WHERE id = $2",
                [req.user.id, withdrawal.id],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'withdrawal_marked_paid',
                target: withdrawal.id,
                previousValue: { status: 'approved' },
                newValue: { status: 'paid' },
            });
            return { withdrawal: await readWithdrawal(client, withdrawal.id, true) };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json({ withdrawal: toPublicWithdrawal(result.withdrawal) });
    } catch (error) { return next(error); }
});

module.exports = { router, isWithdrawalWindowOpen, getEligibleBonus, getWithdrawableAmount, toPublicWithdrawal, toPublicAccount };
