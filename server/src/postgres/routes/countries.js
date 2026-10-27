const express = require('express');
const { pool, transaction, getCountryConfig } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { COUNTRIES, COUNTRY_CODES, COUNTRY_SETTING_KEYS } = require('../../utils/countries');
const { validateSetting } = require('../settingsValidation');

const router = express.Router();

function validateCountryInput(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Country configuration must be an object.';
    if (typeof body.enabled !== 'boolean') return 'Country enabled must be true or false.';
    if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) return 'Country settings must be provided as an object.';
    if (!body.products || typeof body.products !== 'object' || Array.isArray(body.products)) return 'Country product overrides must be provided as an object.';
    for (const key of Object.keys(body.settings)) {
        if (!COUNTRY_SETTING_KEYS.includes(key)) return `Unsupported country setting: ${key}.`;
        const validation = validateSetting(key, body.settings[key]);
        if (validation.error) return validation.error;
    }
    if (Object.keys(body.products).length > 1000) return 'Country products must be a product configuration object.';
    for (const [id, override] of Object.entries(body.products)) {
        if (!override || typeof override !== 'object' || Array.isArray(override)) return `Product ${id} settings must be an object.`;
        for (const [field, value] of Object.entries(override)) {
            if (!['price', 'daily_income_amount', 'daily_income_percent', 'total_income', 'percentage', 'stock', 'slots', 'total_slots', 'duration_days', 'term_days', 'investment_duration_days', 'enabled', 'status'].includes(field)) return `Unsupported country product field: ${field}.`;
            if (field === 'enabled' && typeof value !== 'boolean') return `Product ${id} enabled must be true or false.`;
            if (['price', 'daily_income_amount', 'total_income', 'stock', 'slots', 'total_slots', 'duration_days', 'term_days', 'investment_duration_days'].includes(field) && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) return `Product ${id} ${field} must be a non-negative whole number.`;
            if (['daily_income_percent', 'percentage'].includes(field) && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 100)) return `Product ${id} ${field} must be between 0 and 100.`;
            if (field === 'status' && !['active', 'inactive', 'sold_out', 'open_soon'].includes(value)) return `Product ${id} status is invalid.`;
        }
    }
    const withdraw = body.settings.withdraw;
    if (withdraw) {
        if (typeof withdraw !== 'object' || Array.isArray(withdraw)) return 'Withdrawal settings must be an object.';
        for (const field of ['mtn', 'airtel', 'bank']) {
            const method = withdraw[field];
            if (method && (typeof method !== 'object' || Array.isArray(method) ||
                (method.enabled !== undefined && typeof method.enabled !== 'boolean') ||
                ['min', 'max'].some((key) => method[key] !== undefined && (!Number.isSafeInteger(Number(method[key])) || Number(method[key]) < 0)) ||
                Number(method.max ?? Number.MAX_SAFE_INTEGER) < Number(method.min ?? 0))) return `Withdrawal ${field} settings are invalid.`;
        }
        if (withdraw.feePercent !== undefined && (!Number.isFinite(Number(withdraw.feePercent)) || Number(withdraw.feePercent) < 0 || Number(withdraw.feePercent) > 100)) return 'Withdrawal fee percentage is invalid.';
    }
    const investment = body.settings.investment;
    if (investment && (Number(investment.minimumAmount) < 0 || Number(investment.maximumAmount) < Number(investment.minimumAmount))) return 'Investment limits are invalid.';
    return null;
}

router.get('/', async (_req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const countries = await Promise.all(COUNTRY_CODES.map(async (code) => {
            const config = await getCountryConfig(pool, code);
            return { ...COUNTRIES[code], enabled: config?.enabled ?? false };
        }));
        return res.json({ countries });
    } catch (error) { return next(error); }
});

router.get('/config', requireAuth, async (req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const config = await getCountryConfig(pool, req.user.country_code);
        if (!config?.enabled) return res.status(403).json({ error: 'Your country is currently unavailable.' });
        return res.json({
            country: { code: config.code, name: config.name, currency: config.currency, flag: config.flag, timeZone: config.timeZone },
            settings: config.settings,
            products: config.products,
        });
    } catch (error) { return next(error); }
});

router.get('/admin', requireAdmin, async (_req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const [countries, products] = await Promise.all([
            Promise.all(COUNTRY_CODES.map((code) => getCountryConfig(pool, code))),
            pool.query('SELECT * FROM products ORDER BY created_at DESC'),
        ]);
        return res.json({ countries, products: products.rows });
    } catch (error) { return next(error); }
});

router.put('/:code', requireAdmin, async (req, res, next) => {
    try {
        const code = String(req.params.code || '').toUpperCase();
        if (!COUNTRY_CODES.includes(code)) return res.status(400).json({ error: 'Unsupported country code.' });
        const errorMessage = validateCountryInput(req.body);
        if (errorMessage) return res.status(400).json({ error: errorMessage });
        const unknownProducts = Object.keys(req.body.products).length
            ? await pool.query('SELECT id FROM products WHERE id = ANY($1::text[])', [Object.keys(req.body.products)])
            : { rows: [] };
        const found = new Set(unknownProducts.rows.map(({ id }) => id));
        const missing = Object.keys(req.body.products).find((id) => !found.has(id));
        if (missing) return res.status(400).json({ error: `Unknown product ${missing}.` });
        const country = await transaction(async (client) => {
            const existing = await getCountryConfig(client, code);
            await client.query(
                `UPDATE country_configs SET enabled = $1, settings_json = $2, products_json = $3, updated_at = CURRENT_TIMESTAMP
                 WHERE country_code = $4`,
                [req.body.enabled ? 1 : 0, JSON.stringify(req.body.settings), JSON.stringify(req.body.products), code],
            );
            await client.query(
                `INSERT INTO audit_logs (id, admin_id, action, target, previous_value, new_value)
                 VALUES ($1, $2, 'country_configuration_updated', $3, $4, $5)`,
                [require('../store').uuid(), req.user.id, code, JSON.stringify({ enabled: existing.enabled, settings: existing.settings, products: existing.products }), JSON.stringify(req.body)],
            );
            return getCountryConfig(client, code);
        });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ country });
    } catch (error) { return next(error); }
});

module.exports = { router, validateCountryInput };
