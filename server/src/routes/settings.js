// Key/value admin-configurable settings (welcome bonus, deposit/withdraw config, etc.).
const express = require('express');
const { db } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { COUNTRY_SETTING_KEYS, COUNTRY_CODES, getCountryConfig, getCountrySetting } = require('../utils/countries');

const router = express.Router();
const wholeMoney = (value) => Math.max(0, Math.round(Number(value) || 0));
const isValidTimeZone = (timeZone) => {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return true;
    } catch {
        return false;
    }
};
const isCountrySetting = (key) => COUNTRY_SETTING_KEYS.includes(key);
const countryForRequest = (req) => {
    if (req.user?.role === 'admin' && req.query.country) return String(req.query.country).toUpperCase();
    return req.user?.country_code || 'RW';
};

router.get('/', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach((row) => { settings[row.key] = JSON.parse(row.value_json); });
    const countryCode = countryForRequest(req);
    if (COUNTRY_CODES.includes(countryCode)) {
        for (const key of COUNTRY_SETTING_KEYS) settings[key] = getCountrySetting(db, countryCode, key);
    }
    res.json({ settings });
});

router.get('/:key', (req, res, next) => {
    const publicKeys = new Set(['branding', 'support', 'coffeePlanet']);
    const sendSetting = (countryCode) => {
        if (isCountrySetting(req.params.key)) {
            if (!COUNTRY_CODES.includes(countryCode)) return res.status(400).json({ error: 'Unsupported country code.' });
            const config = getCountryConfig(db, countryCode);
            if (!config?.enabled) return res.status(403).json({ error: 'Country settings are currently unavailable.' });
            res.setHeader('Cache-Control', 'private, no-store');
            return res.json({ key: req.params.key, value: getCountrySetting(db, countryCode, req.params.key), country: { code: config.code, currency: config.currency } });
        }
        const row = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
        res.json({ key: req.params.key, value: row ? JSON.parse(row.value_json) : null });
    };
    if (!isCountrySetting(req.params.key) && publicKeys.has(req.params.key)) return sendSetting(null);
    return requireAuth(req, res, () => {
        const requestedCountry = req.query.country ? String(req.query.country).toUpperCase() : null;
        if (requestedCountry && req.user.role !== 'admin') return res.status(403).json({ error: 'Only administrators may select a country.' });
        sendSetting(requestedCountry || countryForRequest(req));
    });
});

router.put('/:key', requireAdmin, (req, res) => {
    let value = req.body && Object.prototype.hasOwnProperty.call(req.body, 'value')
        ? req.body.value
        : req.body;
    if (value === undefined) return res.status(400).json({ error: 'A value is required.' });

    const numeric = (entry, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isFinite(Number(entry)) && Number(entry) >= minimum && Number(entry) <= maximum;
    if (req.params.key === 'welcomeBonus') {
        if (typeof value !== 'object' || !['fixed', 'percentage'].includes(value.type) || !numeric(value.amount, 0, value.type === 'percentage' ? 100 : Number.MAX_SAFE_INTEGER) || !numeric(value.minimumDeposit) || !numeric(value.expiryDays)) return res.status(400).json({ error: 'Invalid Welcome Bonus settings.' });
        if (value.type === 'fixed') value.amount = wholeMoney(value.amount);
        value.minimumDeposit = wholeMoney(value.minimumDeposit);
    }
    if (req.params.key === 'deposit' && typeof value === 'object' && value !== null) {
        value = {
            ...value,
            mtn: value.mtn ? { ...value.mtn, min: wholeMoney(value.mtn.min), max: wholeMoney(value.mtn.max) } : value.mtn,
            airtel: value.airtel ? { ...value.airtel, min: wholeMoney(value.airtel.min), max: wholeMoney(value.airtel.max) } : value.airtel,
        };
    }
    if (req.params.key === 'withdraw') {
        if (typeof value !== 'object' || value === null) return res.status(400).json({ error: 'Invalid withdrawal settings.' });
        const legacyMinimum = value.mtn?.min ?? value.airtel?.min ?? 0;
        const legacyMaximum = value.mtn?.max ?? value.airtel?.max ?? Number.MAX_SAFE_INTEGER;
        if (value.availability !== undefined) {
            const availability = value.availability;
            const weekdays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
            const openHour = Number(availability?.openHour ?? 0);
            const closeHour = Number(availability?.closeHour ?? 24);
            if (
                typeof availability !== 'object' || availability === null ||
                typeof availability.enabled !== 'boolean' ||
                !Array.isArray(availability.days) ||
                availability.days.some((day) => !weekdays.has(day)) ||
                !Number.isInteger(openHour) || openHour < 0 || openHour > 23 ||
                !Number.isInteger(closeHour) || closeHour < 0 || closeHour > 24 ||
                (availability.timeZone && !isValidTimeZone(availability.timeZone))
            ) return res.status(400).json({ error: 'Invalid withdrawal availability schedule.' });
            value.availability = { ...availability, openHour, closeHour };
        }
        value = {
            ...value,
            feePercent: value.feePercent ?? 0,
            minAmount: wholeMoney(value.minAmount ?? legacyMinimum),
            maxAmount: wholeMoney(value.maxAmount ?? legacyMaximum),
            minimumBalance: wholeMoney(value.minimumBalance ?? 0),
            mtn: value.mtn ? { ...value.mtn, min: wholeMoney(value.mtn.min), max: wholeMoney(value.mtn.max) } : value.mtn,
            airtel: value.airtel ? { ...value.airtel, min: wholeMoney(value.airtel.min), max: wholeMoney(value.airtel.max) } : value.airtel,
        };
        if (!numeric(value.feePercent, 0, 100) || !numeric(value.minAmount) || !numeric(value.maxAmount) || !numeric(value.minimumBalance)) return res.status(400).json({ error: 'Invalid withdrawal settings.' });
        if (Number(value.maxAmount) < Number(value.minAmount)) return res.status(400).json({ error: 'Withdrawal maximum must be at least the minimum.' });
    }
    if (req.params.key === 'investment') {
        if (typeof value !== 'object' || !numeric(value.minimumAmount) || !numeric(value.maximumAmount) || !numeric(value.durationDays) || !numeric(value.dailyRatePercent, 0, 100)) return res.status(400).json({ error: 'Invalid investment settings.' });
        value.minimumAmount = wholeMoney(value.minimumAmount);
        value.maximumAmount = wholeMoney(value.maximumAmount);
        if (Number(value.maximumAmount) < Number(value.minimumAmount)) return res.status(400).json({ error: 'Investment maximum must be at least the minimum.' });
    }
    if (req.params.key === 'chakin') {
        if (typeof value !== 'object' || value === null || typeof value.enabled !== 'boolean' || !numeric(value.reward) || !numeric(value.cooldownHours) || !numeric(value.maxCheckins)) return res.status(400).json({ error: 'Invalid Chakin settings.' });
        value.reward = wholeMoney(value.reward);
        value.cooldownHours = Number(value.cooldownHours);
        value.maxCheckins = Math.floor(Number(value.maxCheckins));
        if (value.endDate && value.startDate && value.endDate < value.startDate) return res.status(400).json({ error: 'Chakin end date must be after the start date.' });
    }
    if (req.params.key === 'giftcode') {
        if (typeof value !== 'object' || value === null || typeof value.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid Gift Code settings.' });
    }
    if (req.params.key === 'coffeePlanet') {
        const validText = (text, maxLength) => typeof text === 'string' && text.length <= maxLength;
        const validImageSource = (src) => {
            if (typeof src !== 'string') return false;
            if (/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) return src.length <= 420000;
            if (src.length > 2048) return false;
            if (/^\/assets\/coffee-slides\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/i.test(src)) return true;
            try {
                return new URL(src).protocol === 'https:';
            } catch (_) {
                return false;
            }
        };
        if (
            typeof value !== 'object' || value === null ||
            !validText(value.title, 100) ||
            !validText(value.subtitle, 160) ||
            !validText(value.aboutTitle, 100) ||
            !validText(value.aboutText, 3000) ||
            !Array.isArray(value.images) || value.images.length > 5 ||
            value.images.some((image) => !image || !validImageSource(image.src) || !validText(image.caption || '', 120))
        ) return res.status(400).json({ error: 'Invalid home page settings. Use up to 5 HTTPS image URLs, bundled coffee photos or small uploaded photos.' });
    }

    const selectedCountry = req.query.country ? String(req.query.country).toUpperCase() : null;
    if (selectedCountry && (!COUNTRY_CODES.includes(selectedCountry) || !isCountrySetting(req.params.key))) {
        return res.status(400).json({ error: 'Choose a supported country and a country-specific setting.' });
    }
    if (isCountrySetting(req.params.key) && selectedCountry) {
        const config = getCountryConfig(db, selectedCountry);
        if (!config) return res.status(400).json({ error: 'Unsupported country code.' });
        const previousValue = config.settings[req.params.key] ?? getCountrySetting(db, selectedCountry, req.params.key);
        const nextSettings = { ...config.settings, [req.params.key]: value };
        db.prepare('UPDATE country_configs SET settings_json = ?, updated_at = datetime(\'now\') WHERE country_code = ?')
            .run(JSON.stringify(nextSettings), selectedCountry);
        const savedValue = getCountrySetting(db, selectedCountry, req.params.key);
        logAudit({ adminId: req.user.id, action: 'country_setting_updated', target: `${selectedCountry}:${req.params.key}`, previousValue, newValue: savedValue });
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ key: req.params.key, value: savedValue, country: selectedCountry });
    }

    const previous = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    db.prepare("INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')")
        .run(req.params.key, JSON.stringify(value));
    const saved = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
    const savedValue = saved ? JSON.parse(saved.value_json) : value;

    logAudit({
        adminId: req.user.id,
        action: 'setting_updated',
        target: req.params.key,
        previousValue: previous ? JSON.parse(previous.value_json) : null,
        newValue: savedValue,
    });
    res.json({ key: req.params.key, value: savedValue, updatedAt: saved?.updated_at || null });
});

module.exports = { router };
