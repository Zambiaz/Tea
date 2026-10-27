const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool, transaction, uuid, getCountryConfig, getCountrySetting } = require('../store');
const { signToken } = require('../../auth');
const { requireAuth } = require('../middleware');
const { generateReferralCode, isReferralCodeFormat } = require('../../utils/referralCodes');
const {
    getCountry,
    getNationalPhoneCandidates,
    isValidNationalPhone,
    normalizeNationalPhone,
} = require('../../utils/countries');

const router = express.Router();

async function publicUser(user) {
    await transaction(async (client) => {
        const { rows: ledgers } = await client.query(
            `SELECT l.*, p.name, p.investment_duration_days, p.duration_days
             FROM product_earning_ledger l JOIN products p ON p.id = l.product_id
             WHERE l.user_id = $1 AND l.status = 'active' AND l.next_credit_at <= CURRENT_TIMESTAMP
             ORDER BY l.next_credit_at ASC FOR UPDATE OF l`,
            [user.id],
        );
        for (const ledger of ledgers) {
            const duration = Number(ledger.investment_duration_days || ledger.duration_days || 0);
            if (duration > 0 && Number(ledger.cycle_day) > duration) {
                await client.query("UPDATE product_earning_ledger SET status = 'completed' WHERE id = $1", [ledger.id]);
                continue;
            }
            const { rows: users } = await client.query('SELECT balance, daily_income_balance FROM users WHERE id = $1 FOR UPDATE', [user.id]);
            const current = users[0];
            const nextBalance = Number(current.balance) + Number(ledger.amount);
            await client.query('UPDATE users SET balance = $1, daily_income_balance = daily_income_balance + $2 WHERE id = $3', [nextBalance, ledger.amount, user.id]);
            await client.query(
                `INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'reward', $3, $4, $5, $6, $7, 'system')`,
                [uuid(), user.id, ledger.amount, current.balance, nextBalance, `Daily income: ${ledger.name}`, ledger.id],
            );
            const nextCycle = Number(ledger.cycle_day) + 1;
            const nextStatus = duration > 0 && nextCycle > duration ? 'completed' : 'active';
            await client.query(
                `UPDATE product_earning_ledger SET cycle_day = $1,
                 next_credit_at = next_credit_at + INTERVAL '24 hours', status = $2 WHERE id = $3`,
                [nextCycle, nextStatus, ledger.id],
            );
        }
    });
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [user.id]);
    user = rows[0];
    const [{ rows: bonuses }, { rows: purchases }] = await Promise.all([
        pool.query('SELECT * FROM user_bonuses WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [user.id]),
        pool.query("SELECT 1 FROM product_purchases WHERE user_id = $1 AND status = 'completed' LIMIT 1", [user.id]),
    ]);
    const bonus = bonuses[0] || null;
    const bonusSettings = await getCountrySetting(pool, user.country_code, 'welcomeBonus') || {};
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
        balance: Number(user.balance),
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
        bonus: bonus ? {
            amount: Number(bonus.amount || 0),
            status: bonus.status,
            depositRequired: Boolean(bonus.deposit_required),
            productRequired: Boolean(bonus.product_required),
            withdrawable: Boolean(bonusSettings.withdrawable) && purchases.length > 0,
            withdrawableAmount: bonus.status === 'UNLOCKED' && bonusSettings.withdrawable !== false && purchases.length > 0 ? Number(bonus.amount || 0) : 0,
            expiresAt: bonus.expires_at,
        } : null,
    };
}

router.post('/register', async (req, res, next) => {
    try {
        const { fullName, phoneNumber, password, confirmPassword, referralCode } = req.body || {};
        const countryCode = String(req.body?.countryCode || '').trim().toUpperCase();
        const country = getCountry(countryCode);
        const config = country && await getCountryConfig(pool, country.code);
        if (!fullName || !phoneNumber || !password || !countryCode) return res.status(400).json({ error: 'Full name, phone number, password and country are required.' });
        if (!country || !config?.enabled) return res.status(400).json({ error: 'Choose a supported country that is currently accepting registrations.' });
        if (!isValidNationalPhone(country.code, phoneNumber)) return res.status(400).json({ error: `Enter a valid local phone number for ${country.name}.` });
        if (!/^\d{5}$/.test(String(password))) return res.status(400).json({ error: 'Password must contain exactly 5 digits.' });
        if (confirmPassword !== password) return res.status(400).json({ error: 'Password confirmation does not match.' });
        if (referralCode !== undefined && typeof referralCode !== 'string') return res.status(400).json({ error: 'Referral code must be text.' });

        const normalizedPhoneNumber = normalizeNationalPhone(country.code, phoneNumber);
        const passwordHash = bcrypt.hashSync(password, 10);
        const id = uuid();
        const normalizedReferralCode = referralCode?.trim().toUpperCase();
        const result = await transaction(async (client) => {
            const existing = await client.query('SELECT id FROM users WHERE phone_number = $1', [normalizedPhoneNumber]);
            if (existing.rowCount) return { error: 'An account with this phone number already exists.', status: 409 };
            let referredBy = null;
            if (normalizedReferralCode) {
                const referrer = await client.query(
                    'SELECT id FROM users WHERE referral_code = $1 UNION SELECT user_id AS id FROM referral_code_aliases WHERE code = $1 LIMIT 1',
                    [normalizedReferralCode],
                );
                if (!referrer.rowCount) return { error: 'Referral code was not found. Check the code or register without it.', status: 400 };
                referredBy = referrer.rows[0].id;
            }
            let ownReferralCode;
            for (let attempt = 0; attempt < 10; attempt += 1) {
                const candidate = generateReferralCode();
                const found = await client.query(
                    'SELECT 1 FROM users WHERE referral_code = $1 UNION SELECT 1 FROM referral_code_aliases WHERE code = $1 LIMIT 1',
                    [candidate],
                );
                if (!found.rowCount) { ownReferralCode = candidate; break; }
            }
            if (!ownReferralCode) throw new Error('Could not allocate a unique referral code.');
            await client.query(
                `INSERT INTO users (id, full_name, phone_number, password_hash, role, country_code, referral_code, referred_by, balance, status)
                 VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, 0, 'Active')`,
                [id, String(fullName).trim(), normalizedPhoneNumber, passwordHash, country.code, ownReferralCode, referredBy],
            );
            const setting = await getCountrySetting(client, country.code, 'welcomeBonus');
            if (setting?.enabled && Number(setting.amount) > 0) {
                const amount = setting.type === 'percentage'
                    ? Math.round(Number(setting.minimumDeposit || 0) * Number(setting.amount) / 100)
                    : Math.round(Number(setting.amount));
                if (amount > 0) {
                    const bonusId = uuid();
                    const expiresAt = Number(setting.expiryDays) > 0 ? new Date(Date.now() + Number(setting.expiryDays) * 86400000) : null;
                    await client.query(
                        `INSERT INTO user_bonuses (id, user_id, amount, status, deposit_required, product_required, expires_at)
                         VALUES ($1, $2, $3, 'UNLOCKED', $4, 1, $5)`,
                        [bonusId, id, amount, setting.depositRequired ? 1 : 0, expiresAt],
                    );
                    await client.query('UPDATE users SET balance = balance + $1, bonus_balance = bonus_balance + $1 WHERE id = $2', [amount, id]);
                    await client.query(
                        `INSERT INTO reward_transactions (id, user_id, type, amount, source, reference_id, previous_balance, new_balance, status)
                         VALUES ($1, $2, 'welcome_bonus', $3, 'Welcome Bonus', $4, 0, $3, 'completed')`,
                        [uuid(), id, amount, bonusId],
                    );
                }
            }
            const { rows } = await client.query('SELECT * FROM users WHERE id = $1', [id]);
            return { user: rows[0] };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.status(201).json({ user: await publicUser(result.user) });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'An account with this phone number or referral code already exists.' });
        return next(error);
    }
});

router.post('/login', async (req, res, next) => {
    try {
        const { phoneNumber, password } = req.body || {};
        const countryCode = String(req.body?.countryCode || '').trim().toUpperCase();
        if (!phoneNumber || !password) return res.status(400).json({ error: 'Phone number and password are required.' });
        let user;
        if (countryCode) {
            const candidates = getNationalPhoneCandidates(countryCode, phoneNumber);
            if (!candidates.length) return res.status(400).json({ error: 'Enter a valid local phone number for your selected country.' });
            const { rows } = await pool.query('SELECT * FROM users WHERE country_code = $1 AND phone_number = ANY($2::text[]) LIMIT 1', [countryCode, candidates]);
            user = rows[0];
        } else {
            const { rows } = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
            user = rows[0];
        }
        if (!user || !bcrypt.compareSync(String(password), user.password_hash)) return res.status(401).json({ error: 'Invalid phone number or password.' });
        if (user.status !== 'Active') return res.status(403).json({ error: `Your account is ${user.status.toLowerCase()}. Contact support.`, status: user.status });
        if (user.login_blocked) return res.status(403).json({ error: 'Login is disabled for this account.', status: 'Blocked' });
        await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);
        return res.json({ token: signToken(user), user: await publicUser(user) });
    } catch (error) { return next(error); }
});

router.get('/me', requireAuth, async (req, res, next) => {
    try { return res.json({ user: await publicUser(req.user) }); } catch (error) { return next(error); }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
    try {
        const { currentPassword, newPassword } = req.body || {};
        if (!currentPassword || !/^\d{5}$/.test(String(newPassword || ''))) return res.status(400).json({ error: 'Current password and a new 5-digit numeric password are required.' });
        if (!bcrypt.compareSync(String(currentPassword), req.user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect.' });
        await pool.query('UPDATE users SET password_hash = $1, must_reset_password = 0, auth_version = auth_version + 1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), req.user.id]);
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.put('/language', requireAuth, async (req, res, next) => {
    try {
        const language = String(req.body?.language || '').toLowerCase();
        if (!['en', 'rw', 'fr'].includes(language)) return res.status(400).json({ error: 'Unsupported language.' });
        await pool.query('UPDATE users SET language = $1 WHERE id = $2', [language, req.user.id]);
        return res.json({ language });
    } catch (error) { return next(error); }
});

router.put('/appearance', requireAuth, async (req, res, next) => {
    try {
        const appearance = String(req.body?.appearance || '').toLowerCase();
        if (!['light', 'dark', 'system'].includes(appearance)) return res.status(400).json({ error: 'Unsupported appearance.' });
        await pool.query('UPDATE users SET appearance = $1 WHERE id = $2', [appearance, req.user.id]);
        return res.json({ appearance });
    } catch (error) { return next(error); }
});

router.post('/reset-password', async (req, res, next) => {
    try {
        const { resetToken, newPassword } = req.body || {};
        if (!resetToken || !/^\d{5}$/.test(String(newPassword || ''))) return res.status(400).json({ error: 'A reset token and a new 5-digit numeric password are required.' });
        const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
        const result = await transaction(async (client) => {
            const { rows } = await client.query(
                'SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP FOR UPDATE',
                [tokenHash],
            );
            const token = rows[0];
            if (!token) return false;
            await client.query('UPDATE users SET password_hash = $1, must_reset_password = 0, auth_version = auth_version + 1 WHERE id = $2', [bcrypt.hashSync(newPassword, 10), token.user_id]);
            await client.query('UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [token.id]);
            return true;
        });
        if (!result) return res.status(400).json({ error: 'This reset token is invalid or expired.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

module.exports = { router };
