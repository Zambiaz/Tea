// Registration/login for both normal users and admins (role is decided server-side, never by the client).
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, uuid } = require('../db');
const { signToken } = require('../auth');
const { requireAuth } = require('../middleware/auth');
const { generateReferralCode } = require('../utils/referralCodes');
const {
    getCountry,
    getCountryConfig,
    getCountrySetting,
    isValidNationalPhone,
    normalizeNationalPhone,
    getNationalPhoneCandidates,
} = require('../utils/countries');

const router = express.Router();

function processDueProductEarnings(userId) {
    const ledgers = db.prepare(`
        SELECT l.*, p.name, p.investment_duration_days, p.duration_days
        FROM product_earning_ledger l
        JOIN products p ON p.id = l.product_id
        WHERE l.user_id = ? AND l.status = 'active' AND l.next_credit_at <= datetime('now')
        ORDER BY l.next_credit_at ASC
    `).all(userId);
    for (const ledger of ledgers) {
        const duration = Number(ledger.investment_duration_days || ledger.duration_days || 0);
        if (duration > 0 && Number(ledger.cycle_day) > duration) {
            db.prepare("UPDATE product_earning_ledger SET status = 'completed' WHERE id = ?").run(ledger.id);
            continue;
        }
        const user = db.prepare('SELECT balance, daily_income_balance FROM users WHERE id = ?').get(userId);
        const nextBalance = Number(user.balance) + Number(ledger.amount);
        db.prepare('UPDATE users SET balance = ?, daily_income_balance = daily_income_balance + ? WHERE id = ?')
            .run(nextBalance, ledger.amount, userId);
        db.prepare('INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, \'reward\', ?, ?, ?, ?, ?, \'system\')')
            .run(uuid(), userId, ledger.amount, user.balance, nextBalance, `Daily income: ${ledger.name}`, ledger.id);
        const nextCycle = Number(ledger.cycle_day) + 1;
        const nextStatus = duration > 0 && nextCycle > duration ? 'completed' : 'active';
        db.prepare("UPDATE product_earning_ledger SET cycle_day = ?, next_credit_at = datetime(next_credit_at, '+24 hours'), status = ? WHERE id = ?")
            .run(nextCycle, nextStatus, ledger.id);
    }
}

function toPublicUser(user) {
    processDueProductEarnings(user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    const bonus = db.prepare('SELECT * FROM user_bonuses WHERE user_id = ?').get(user.id);
    const hasProductPurchase = !!db.prepare("SELECT 1 FROM product_purchases WHERE user_id = ? AND status = 'completed' LIMIT 1").get(user.id);
    const bonusSettings = getCountrySetting(db, user.country_code, 'welcomeBonus') || {};
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
        balance: user.balance,
        pointsBalance: user.points_balance || 0,
        status: user.status,
        language: user.language || 'en',
        appearance: user.appearance || 'system',
        mustResetPassword: !!user.must_reset_password,
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
            depositRequired: !!bonus.deposit_required,
            productRequired: !!bonus.product_required,
            withdrawable: !!bonusSettings.withdrawable && hasProductPurchase,
            withdrawableAmount: bonus.status === 'UNLOCKED' && bonusSettings.withdrawable !== false && hasProductPurchase ? Number(bonus.amount || 0) : 0,
            expiresAt: bonus.expires_at,
        } : null,
    };
}

router.post('/register', (req, res) => {
    const { fullName, phoneNumber, password, confirmPassword, referralCode } = req.body || {};
    const countryCode = String(req.body?.countryCode || '').trim().toUpperCase();
    const country = getCountry(countryCode);
    const countryConfig = country && getCountryConfig(db, country.code);
    if (!fullName || !phoneNumber || !password || !countryCode) {
        return res.status(400).json({ error: 'Full name, phone number, password and country are required.' });
    }
    if (!country || !countryConfig?.enabled) return res.status(400).json({ error: 'Choose a supported country that is currently accepting registrations.' });
    if (!isValidNationalPhone(country.code, phoneNumber)) {
        return res.status(400).json({ error: `Enter a valid local phone number for ${country.name}.` });
    }
    if (!/^\d{5}$/.test(String(password))) {
        return res.status(400).json({ error: 'Password must contain exactly 5 digits.' });
    }
    if (confirmPassword !== password) {
        return res.status(400).json({ error: 'Password confirmation does not match.' });
    }
    if (referralCode !== undefined && typeof referralCode !== 'string') {
        return res.status(400).json({ error: 'Referral code must be text.' });
    }

    const normalizedPhoneNumber = normalizeNationalPhone(country.code, phoneNumber);
    const existing = db.prepare('SELECT id FROM users WHERE phone_number = ?').get(normalizedPhoneNumber);
    if (existing) return res.status(409).json({ error: 'An account with this phone number already exists.' });

    let referredBy = null;
    const normalizedReferralCode = referralCode?.trim().toUpperCase();
    if (normalizedReferralCode) {
        const referrer = db.prepare(`
            SELECT id FROM users WHERE referral_code = ?
            UNION
            SELECT user_id AS id FROM referral_code_aliases WHERE code = ?
            LIMIT 1
        `).get(normalizedReferralCode, normalizedReferralCode);
        if (!referrer) return res.status(400).json({ error: 'Referral code was not found. Check the code or register without it.' });
        if (referrer) referredBy = referrer.id;
    }

    const id = uuid();
    let ownReferralCode;
    do {
        ownReferralCode = generateReferralCode();
    } while (db.prepare('SELECT 1 FROM users WHERE referral_code = ? UNION SELECT 1 FROM referral_code_aliases WHERE code = ? LIMIT 1').get(ownReferralCode, ownReferralCode));
    const passwordHash = bcrypt.hashSync(password, 10);

    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare(
            'INSERT INTO users (id, full_name, phone_number, password_hash, role, country_code, referral_code, referred_by, balance, status) VALUES (?, ?, ?, ?, \'user\', ?, ?, ?, 0, \'Active\')',
        ).run(id, fullName, normalizedPhoneNumber, passwordHash, country.code, ownReferralCode, referredBy);
        const setting = getCountrySetting(db, country.code, 'welcomeBonus');
        if (setting?.enabled && Number(setting.amount) > 0) {
            const amount = setting.type === 'percentage'
                ? Math.round(Number(setting.minimumDeposit || 0) * Number(setting.amount) / 100)
                : Math.round(Number(setting.amount));
            if (amount > 0) {
                const status = 'UNLOCKED';
                const bonusId = uuid();
                const expiry = Number(setting.expiryDays) > 0 ? new Date(Date.now() + Number(setting.expiryDays) * 86400000).toISOString() : null;
                db.prepare('INSERT INTO user_bonuses (id, user_id, amount, status, deposit_required, product_required, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(bonusId, id, amount, status, setting.depositRequired ? 1 : 0, 1, expiry);
                db.prepare('UPDATE users SET balance = balance + ?, bonus_balance = bonus_balance + ? WHERE id = ?').run(amount, amount, id);
                db.prepare('INSERT INTO reward_transactions (id, user_id, type, amount, source, reference_id, previous_balance, new_balance, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(uuid(), id, 'welcome_bonus', amount, 'Welcome Bonus', bonusId, 0, amount, 'completed');
            }
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Unable to create account.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.status(201).json({ user: toPublicUser(user) });
});

router.post('/login', (req, res) => {
    const { phoneNumber, password } = req.body || {};
    const countryCode = String(req.body?.countryCode || '').trim().toUpperCase();
    if (!phoneNumber || !password) return res.status(400).json({ error: 'Phone number and password are required.' });

    let user;
    if (countryCode) {
        const candidates = getNationalPhoneCandidates(countryCode, phoneNumber);
        if (!candidates.length) return res.status(400).json({ error: 'Enter a valid local phone number for your selected country.' });
        const placeholders = candidates.map(() => '?').join(', ');
        user = db.prepare(`SELECT * FROM users WHERE country_code = ? AND phone_number IN (${placeholders})`).get(countryCode, ...candidates);
    } else {
        user = db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber);
    }
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid phone number or password.' });
    }
    if (user.status !== 'Active') {
        return res.status(403).json({ error: `Your account is ${user.status.toLowerCase()}. Contact support.`, status: user.status });
    }
    if (user.login_blocked) {
        return res.status(403).json({ error: 'Login is disabled for this account.', status: 'Blocked' });
    }

    db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);

    const token = signToken(user);
    res.json({ token, user: toPublicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
    res.json({ user: toPublicUser(req.user) });
});

router.post('/change-password', requireAuth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !/^\d{5}$/.test(String(newPassword || ''))) {
        return res.status(400).json({ error: 'Current password and a new 5-digit numeric password are required.' });
    }
    if (!bcrypt.compareSync(currentPassword, req.user.password_hash)) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(passwordHash, req.user.id);
    res.json({ ok: true });
});

router.put('/language', requireAuth, (req, res) => {
    const language = String(req.body?.language || '').toLowerCase();
    if (!['en', 'rw', 'fr'].includes(language)) return res.status(400).json({ error: 'Unsupported language.' });
    db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.user.id);
    res.json({ language });
});

router.put('/appearance', requireAuth, (req, res) => {
    const appearance = String(req.body?.appearance || '').toLowerCase();
    if (!['light', 'dark', 'system'].includes(appearance)) return res.status(400).json({ error: 'Unsupported appearance.' });
    db.prepare('UPDATE users SET appearance = ? WHERE id = ?').run(appearance, req.user.id);
    res.json({ appearance });
});

router.post('/reset-password', (req, res) => {
    const { resetToken, newPassword } = req.body || {};
    if (!resetToken || !/^\d{5}$/.test(String(newPassword || ''))) {
        return res.status(400).json({ error: 'A reset token and a new 5-digit numeric password are required.' });
    }

    const tokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
    const token = db.prepare(
        "SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
    ).get(tokenHash);
    if (!token) return res.status(400).json({ error: 'This reset token is invalid or expired.' });

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ?, must_reset_password = 0 WHERE id = ?').run(passwordHash, token.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(token.id);
    res.json({ ok: true });
});

module.exports = { router, toPublicUser };
