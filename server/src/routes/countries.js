const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
    COUNTRIES,
    COUNTRY_CODES,
    COUNTRY_SETTING_KEYS,
    getCountryConfig,
} = require('../utils/countries');
const { logAudit } = require('../utils/auditLogger');

const router = express.Router();
const moneyFields = new Set(['price', 'daily_income_amount', 'daily_income_percent', 'total_income', 'percentage']);
const integerFields = new Set(['stock', 'slots', 'total_slots', 'duration_days', 'term_days', 'investment_duration_days']);
const productFields = new Set([
    ...moneyFields,
    ...integerFields,
    'enabled',
    'status',
]);
const productStatuses = new Set(['active', 'inactive', 'sold_out', 'open_soon']);
const methodNames = new Set(['mtn', 'airtel', 'bank']);

function validNonNegative(value) {
    return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function validAmount(value) {
    return Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function validateLimits(settings, name, minimumKey, maximumKey) {
    const value = settings[name];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${name} settings must be an object.`;
    for (const method of methodNames) {
        const config = value[method];
        if (!config) continue;
        if (typeof config !== 'object' || Array.isArray(config)) return `${name}.${method} settings must be an object.`;
        if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return `${name}.${method}.enabled must be true or false.`;
        for (const field of [minimumKey, maximumKey]) {
            if (config[field] !== undefined && !validAmount(config[field])) return `${name}.${method}.${field} must be a non-negative whole amount.`;
        }
        if (Number(config[maximumKey] ?? Number.MAX_SAFE_INTEGER) < Number(config[minimumKey] ?? 0)) {
            return `${name}.${method} maximum must be at least its minimum.`;
        }
    }
    for (const field of [minimumKey, maximumKey]) {
        if (value[field] !== undefined && !validAmount(value[field])) return `${name}.${field} must be a non-negative whole amount.`;
    }
    if (Number(value[maximumKey] ?? Number.MAX_SAFE_INTEGER) < Number(value[minimumKey] ?? 0)) {
        return `${name} maximum must be at least its minimum.`;
    }
    return null;
}

function validateSettings(settings) {
    for (const key of Object.keys(settings)) {
        if (!COUNTRY_SETTING_KEYS.includes(key)) return `Unsupported country setting: ${key}.`;
        const value = settings[key];
        const listSetting = key === 'commissions' || key === 'inviteRewards';
        if (!value || typeof value !== 'object' || (Array.isArray(value) !== listSetting)) {
            return `${key} settings must be a ${listSetting ? 'list' : 'settings object'}.`;
        }
    }
    let error = settings.deposit && validateLimits(settings, 'deposit', 'min', 'max');
    if (error) return error;
    if (settings.deposit?.enabled !== undefined && typeof settings.deposit.enabled !== 'boolean') return 'Deposit enabled must be true or false.';
    if (settings.deposit?.proofRequired !== undefined && typeof settings.deposit.proofRequired !== 'boolean') return 'Deposit proof requirement must be true or false.';
    error = settings.withdraw && validateLimits(settings, 'withdraw', 'minAmount', 'maxAmount');
    if (error) return error;
    if (settings.withdraw) {
        const withdrawal = settings.withdraw;
        if ((withdrawal.enabled !== undefined && typeof withdrawal.enabled !== 'boolean') ||
            (withdrawal.accountHolderNameRequired !== undefined && typeof withdrawal.accountHolderNameRequired !== 'boolean') ||
            (withdrawal.feePercent !== undefined && (!validNonNegative(withdrawal.feePercent) || Number(withdrawal.feePercent) > 100)) ||
            (withdrawal.minimumBalance !== undefined && !validAmount(withdrawal.minimumBalance))) {
            return 'Withdrawal settings are invalid.';
        }
        if (withdrawal.availability !== undefined) {
            const availability = withdrawal.availability;
            const days = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
            if (!availability || typeof availability !== 'object' || Array.isArray(availability) ||
                typeof availability.enabled !== 'boolean' || !Array.isArray(availability.days) ||
                availability.days.some((day) => !days.has(day)) ||
                !Number.isInteger(Number(availability.openHour)) || Number(availability.openHour) < 0 || Number(availability.openHour) > 23 ||
                !Number.isInteger(Number(availability.closeHour)) || Number(availability.closeHour) < 0 || Number(availability.closeHour) > 24) {
                return 'Withdrawal availability settings are invalid.';
            }
        }
        if (withdrawal.bonusMessage !== undefined) {
            const message = withdrawal.bonusMessage;
            if (!message || typeof message !== 'object' || Array.isArray(message) ||
                (message.enabled !== undefined && typeof message.enabled !== 'boolean') ||
                (message.amount !== undefined && !validAmount(message.amount))) return 'Withdrawal bonus message settings are invalid.';
        }
    }

    const investment = settings.investment;
    if (investment) {
        if (!validAmount(investment.minimumAmount) || !validAmount(investment.maximumAmount) ||
            !validNonNegative(investment.durationDays) || !validNonNegative(investment.dailyRatePercent) ||
            Number(investment.dailyRatePercent) > 100 ||
            Number(investment.maximumAmount) < Number(investment.minimumAmount)) {
            return 'Investment prices, limits, and duration are invalid.';
        }
        if (investment.enabled !== undefined && typeof investment.enabled !== 'boolean') return 'Investment enabled must be true or false.';
        if (investment.availableAmounts !== undefined && (!Array.isArray(investment.availableAmounts) ||
            investment.availableAmounts.length > 100 || investment.availableAmounts.some((amount) => !validAmount(amount)))) {
            return 'Investment available amounts must be non-negative whole amounts.';
        }
    }
    const bonus = settings.welcomeBonus;
    if (bonus && (typeof bonus.enabled !== 'boolean' || !['fixed', 'percentage'].includes(bonus.type) ||
        !(bonus.type === 'percentage' ? validNonNegative(bonus.amount) : validAmount(bonus.amount)) || !validAmount(bonus.minimumDeposit) ||
        (bonus.type === 'percentage' && Number(bonus.amount) > 100) ||
        (bonus.depositRequired !== undefined && typeof bonus.depositRequired !== 'boolean') ||
        (bonus.productPurchaseRequired !== undefined && typeof bonus.productPurchaseRequired !== 'boolean') ||
        (bonus.withdrawable !== undefined && typeof bonus.withdrawable !== 'boolean') ||
        (bonus.expiryDays !== undefined && !validNonNegative(bonus.expiryDays)))) {
        return 'Welcome bonus settings are invalid.';
    }
    const chakin = settings.chakin;
    if (chakin && (typeof chakin.enabled !== 'boolean' || !validAmount(chakin.reward) ||
        !validNonNegative(chakin.cooldownHours) || !validNonNegative(chakin.maxCheckins) ||
        (chakin.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(chakin.startDate)) ||
        (chakin.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(chakin.endDate)) ||
        (chakin.startDate && chakin.endDate && chakin.endDate < chakin.startDate))) {
        return 'Check-in reward settings are invalid.';
    }
    const giftcode = settings.giftcode;
    if (giftcode && typeof giftcode.enabled !== 'boolean') return 'Gift code settings are invalid.';
    const commissions = settings.commissions;
    if (commissions && (!Array.isArray(commissions) || commissions.length > 10 ||
        commissions.some((item) => !Number.isInteger(Number(item.level)) || Number(item.level) < 1 ||
            Number(item.level) > 10 || !validNonNegative(item.percent) || Number(item.percent) > 100))) {
        return 'Referral commission settings are invalid.';
    }
    const rewards = settings.inviteRewards;
    if (rewards && (!Array.isArray(rewards) || rewards.length > 100 ||
        rewards.some((item) => !item.id || typeof item.id !== 'string' ||
            !Number.isInteger(Number(item.requiredInvites)) || Number(item.requiredInvites) < 1 ||
            !validAmount(item.reward) || (item.enabled !== undefined && typeof item.enabled !== 'boolean')))) {
        return 'Referral reward settings are invalid.';
    }
    return null;
}

function validateProducts(products) {
    if (!products || typeof products !== 'object' || Array.isArray(products) ||
        Object.keys(products).length > 1000) return 'Country products must be a product configuration object.';
    const knownProducts = new Set(db.prepare('SELECT id FROM products').all().map(({ id }) => id));
    for (const [id, override] of Object.entries(products)) {
        if (!knownProducts.has(id)) return `Unknown product ${id}.`;
        if (!override || typeof override !== 'object' || Array.isArray(override)) return `Product ${id} settings must be an object.`;
        for (const [field, value] of Object.entries(override)) {
            if (!productFields.has(field)) return `Unsupported country product field: ${field}.`;
            if (field === 'enabled' && typeof value !== 'boolean') return `Product ${id} enabled must be true or false.`;
            if (field === 'status' && !productStatuses.has(value)) return `Product ${id} status is invalid.`;
            if (moneyFields.has(field) && (!(field.includes('percent') || field === 'percentage' ? validNonNegative(value) : validAmount(value)) ||
                ((field.includes('percent') || field === 'percentage') && Number(value) > 100))) {
                return `Product ${id} ${field} must be a valid non-negative amount.`;
            }
            if (integerFields.has(field) && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
                return `Product ${id} ${field} must be a non-negative whole number.`;
            }
        }
    }
    return null;
}

router.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const countries = COUNTRY_CODES.map((code) => {
        const country = COUNTRIES[code];
        const config = getCountryConfig(db, code);
        return { ...country, enabled: config?.enabled ?? false };
    });
    res.json({ countries });
});

router.get('/config', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const config = getCountryConfig(db, req.user.country_code);
    if (!config?.enabled) return res.status(403).json({ error: 'Your country is currently unavailable.' });
    res.json({
        country: { code: config.code, name: config.name, currency: config.currency, flag: config.flag, timeZone: config.timeZone },
        settings: config.settings,
        products: config.products,
    });
});

router.get('/admin', requireAdmin, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
        countries: COUNTRY_CODES.map((code) => getCountryConfig(db, code)),
        products: db.prepare('SELECT * FROM products ORDER BY created_at DESC').all(),
    });
});

router.put('/:code', requireAdmin, (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    if (!COUNTRY_CODES.includes(code)) return res.status(400).json({ error: 'Unsupported country code.' });
    const existing = getCountryConfig(db, code);
    const body = req.body || {};
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'Country enabled must be true or false.' });
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
        return res.status(400).json({ error: 'Country settings must be provided as an object.' });
    }
    if (!body.products || typeof body.products !== 'object' || Array.isArray(body.products)) {
        return res.status(400).json({ error: 'Country product overrides must be provided as an object.' });
    }
    const settingsError = validateSettings(body.settings);
    if (settingsError) return res.status(400).json({ error: settingsError });
    const productsError = validateProducts(body.products);
    if (productsError) return res.status(400).json({ error: productsError });

    const previous = { enabled: existing.enabled, settings: existing.settings, products: existing.products };
    const next = { enabled: body.enabled, settings: body.settings, products: body.products };
    db.prepare(`
        UPDATE country_configs
        SET enabled = ?, settings_json = ?, products_json = ?, updated_at = datetime('now')
        WHERE country_code = ?
    `).run(Number(next.enabled), JSON.stringify(next.settings), JSON.stringify(next.products), code);
    logAudit({
        adminId: req.user.id,
        action: 'country_configuration_updated',
        target: code,
        previousValue: previous,
        newValue: next,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ country: getCountryConfig(db, code) });
});

module.exports = { router, validateSettings, validateProducts };
