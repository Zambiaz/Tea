const express = require('express');
const { pool, transaction, getCountryConfig, getCountrySetting, uuid } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { COUNTRY_SETTING_KEYS, COUNTRY_CODES } = require('../../utils/countries');
const { validateSetting } = require('../settingsValidation');

const router = express.Router();
const publicKeys = new Set(['branding', 'support', 'coffeePlanet']);
const countryKey = (key) => COUNTRY_SETTING_KEYS.includes(key);
const countryFor = (req) => req.user?.role === 'admin' && req.query.country ? String(req.query.country).toUpperCase() : req.user?.country_code || 'RW';

router.get('/', requireAuth, async (req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const { rows } = await pool.query('SELECT key, value_json FROM settings');
        const settings = Object.fromEntries(rows.map((row) => [row.key, typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json]));
        const code = countryFor(req);
        if (COUNTRY_CODES.includes(code)) {
            for (const key of COUNTRY_SETTING_KEYS) settings[key] = await getCountrySetting(pool, code, key);
        }
        return res.json({ settings });
    } catch (error) { return next(error); }
});

router.get('/:key', async (req, res, next) => {
    const send = async (code) => {
        if (countryKey(req.params.key)) {
            if (!COUNTRY_CODES.includes(code)) return res.status(400).json({ error: 'Unsupported country code.' });
            const config = await getCountryConfig(pool, code);
            if (!config?.enabled) return res.status(403).json({ error: 'Country settings are currently unavailable.' });
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json({ key: req.params.key, value: await getCountrySetting(pool, code, req.params.key), country: { code: config.code, currency: config.currency } });
        }
        const { rows } = await pool.query('SELECT value_json FROM settings WHERE key = $1', [req.params.key]);
        const value = rows[0]?.value_json;
        return res.json({ key: req.params.key, value: value === undefined ? null : typeof value === 'string' ? JSON.parse(value) : value });
    };
    try {
        if (!countryKey(req.params.key) && publicKeys.has(req.params.key)) return await send(null);
        return requireAuth(req, res, async () => {
            const requested = req.query.country ? String(req.query.country).toUpperCase() : null;
            if (requested && req.user.role !== 'admin') return res.status(403).json({ error: 'Only administrators may select a country.' });
            try { await send(requested || countryFor(req)); } catch (error) { next(error); }
        });
    } catch (error) { return next(error); }
});

router.put('/:key', requireAdmin, async (req, res, next) => {
    try {
        const key = req.params.key;
        let value = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value') ? req.body.value : req.body;
        if (value === undefined) return res.status(400).json({ error: 'A value is required.' });
        const validation = validateSetting(key, value);
        if (validation.error) return res.status(400).json({ error: validation.error });
        value = validation.value;
        if (countryKey(key) && req.query.country) {
            const code = String(req.query.country).toUpperCase();
            if (!COUNTRY_CODES.includes(code)) return res.status(400).json({ error: 'Choose a supported country and a country-specific setting.' });
            const result = await transaction(async (client) => {
                const config = await getCountryConfig(client, code);
                if (!config) return null;
                const previous = config.settings[key] ?? await getCountrySetting(client, code, key);
                const next = { ...config.settings, [key]: value };
                await client.query('UPDATE country_configs SET settings_json = $1, updated_at = CURRENT_TIMESTAMP WHERE country_code = $2', [JSON.stringify(next), code]);
                await client.query(
                    'INSERT INTO audit_logs (id, admin_id, action, target, previous_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
                    [uuid(), req.user.id, 'country_setting_updated', `${code}:${key}`, JSON.stringify(previous), JSON.stringify(value)],
                );
                return value;
            });
            if (result === null) return res.status(400).json({ error: 'Unsupported country code.' });
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json({ key, value: result, country: code });
        }
        const saved = await transaction(async (client) => {
            const { rows } = await client.query('SELECT value_json FROM settings WHERE key = $1', [key]);
            const previous = rows[0]?.value_json;
            await client.query(
                `INSERT INTO settings (key, value_json, created_at, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = CURRENT_TIMESTAMP`,
                [key, JSON.stringify(value)],
            );
            await client.query(
                'INSERT INTO audit_logs (id, admin_id, action, target, previous_value, new_value) VALUES ($1, $2, $3, $4, $5, $6)',
                [uuid(), req.user.id, 'setting_updated', key, previous === undefined ? null : JSON.stringify(previous), JSON.stringify(value)],
            );
            return value;
        });
        return res.json({ key, value: saved });
    } catch (error) { return next(error); }
});

module.exports = { router };
