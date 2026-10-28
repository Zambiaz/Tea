const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { COUNTRIES, COUNTRY_SETTING_KEYS } = require('../utils/countries');

if ((process.env.NODE_ENV === 'production' || process.env.VERCEL) && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error('Production PostgreSQL mode requires a JWT_SECRET of at least 32 characters.');
}

let actualPool;
let readyPromise;
function uuid() { return crypto.randomUUID(); }

function getPool() {
    if (!actualPool) {
        actualPool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: Number(process.env.PG_POOL_MAX || 3),
            idleTimeoutMillis: 10000,
            connectionTimeoutMillis: 10000,
            ...(process.env.PGSSL === 'disable' ? {} : { ssl: { rejectUnauthorized: true } }),
        });
    }
    return actualPool;
}

const pool = {
    connect(...args) { return getPool().connect(...args); },
    query(...args) { return getPool().query(...args); },
};

async function transactionWith(databasePool, callback) {
    const client = await databasePool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
    }
}

function transaction(callback) {
    return transactionWith(pool, callback);
}

async function seed(client) {
    const defaults = {
        welcomeBonus: { enabled: false, type: 'fixed', amount: 0, minimumDeposit: 0, depositRequired: true, productPurchaseRequired: false, withdrawable: true, expiryDays: 0 },
        deposit: { enabled: true, mtn: { enabled: true, merchantName: 'Pending admin setup', merchantPhone: 'Pending admin setup', min: 6000, max: 5000000, instructions: '', verification: '' }, airtel: { enabled: true, merchantName: 'Pending admin setup', merchantPhone: 'Pending admin setup', min: 3000, max: 5000000, instructions: '', verification: '' }, instructions: '', proofRequired: true },
        withdraw: { enabled: true, mtn: { enabled: true, min: 2000, max: 500000 }, airtel: { enabled: true, min: 2000, max: 500000 }, bank: { enabled: false, min: 2000, max: 500000 }, feePercent: 5, minAmount: 2000, maxAmount: 500000, minimumBalance: 0, processingMessage: 'Payouts are processed after approval.', accountHolderNameRequired: true, availability: { enabled: true, days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], openHour: 0, closeHour: 24, timezoneLabel: 'Kigali time' }, bonusMessage: { enabled: false, amount: 0, text: '' } },
        investment: { enabled: true, minimumAmount: 6000, maximumAmount: 5000000, availableAmounts: [], durationDays: 0, dailyRatePercent: 0 },
        support: { telegramLink: '', telegramUsername: '', phone: '', whatsapp: '', email: '', message: 'Need help? Reach out to our support team.', availability: '', channelsEnabled: { telegram: false, whatsapp: false, phone: false, email: false } },
        branding: { brandName: 'BMG', tagline: 'Beyond My Goals', logoUrl: '', balanceImageUrl: 'Pasted Image', faviconUrl: '', primaryColor: '#3a6b7c', secondaryColor: '#2c5361', glassCardsEnabled: true },
        coffeePlanet: { title: 'Home', subtitle: 'Select a service to get started', aboutTitle: 'About Us', aboutText: 'We connect our members with carefully selected products and offer clear account tools to manage their activity.\n\nMembers can track their plans, invite friends, and review available tasks and account transactions from one place.', images: [] },
        chakin: { enabled: true, reward: 0, cooldownHours: 24, maxCheckins: 0, startDate: '', endDate: '', timezone: 'Africa/Kigali', timezoneLabel: 'Kigali time' },
        giftcode: { enabled: true },
    };
    for (const [key, value] of Object.entries(defaults)) {
        await client.query(
            'INSERT INTO settings (key, value_json) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [key, JSON.stringify(value)],
        );
    }
    const countrySettings = Object.fromEntries(COUNTRY_SETTING_KEYS.map((key) => [key, defaults[key]]).filter(([, value]) => value !== undefined));
    countrySettings.commissions = [{ level: 1, percent: 27 }, { level: 2, percent: 3 }, { level: 3, percent: 1 }];
    countrySettings.inviteRewards = [];
    for (const country of Object.values(COUNTRIES)) {
        const settings = JSON.parse(JSON.stringify(countrySettings));
        if (settings.withdraw?.availability) {
            const timeZoneCity = country.timeZone.split('/').pop().replace(/_/g, ' ');
            settings.withdraw.availability.timeZone = country.timeZone;
            settings.withdraw.availability.timezoneLabel = `${timeZoneCity} time`;
        }
        await client.query(
            `INSERT INTO country_configs (country_code, enabled, settings_json, products_json)
             VALUES ($1, 1, $2, '{}') ON CONFLICT (country_code) DO NOTHING`,
            [country.code, JSON.stringify(settings)],
        );
    }
    for (const [level, percent] of [[1, 27], [2, 3], [3, 1]]) {
        await client.query('INSERT INTO commissions (level, percent) VALUES ($1, $2) ON CONFLICT (level) DO NOTHING', [level, percent]);
    }
    for (const task of [
        ['chakin', 'Chakin', 'Daily check-in activity.'],
        ['giftcode', 'Gift Code', 'Redeem a gift code.'],
        ['spinwin', 'Spin & Win', 'Spin for a chance to win rewards.'],
    ]) {
        await client.query(
            `INSERT INTO tasks (id, slug, title, description, reward, enabled)
             VALUES ($1, $2, $3, $4, 0, 1) ON CONFLICT (slug) DO NOTHING`,
            [uuid(), ...task],
        );
    }
    for (const [requiredInvites, reward] of [[5, 2500], [10, 10000], [20, 20000], [50, 25000], [100, 70000]]) {
        await client.query(
            `INSERT INTO invite_rewards (id, required_invites, reward, enabled)
             SELECT $1, $2, $3, 1
             WHERE NOT EXISTS (SELECT 1 FROM invite_rewards WHERE required_invites = $2)`,
            [uuid(), requiredInvites, reward],
        );
    }
    await client.query(
        `INSERT INTO spin_config (id, enabled, daily_spins, prizes_json)
         VALUES (1, 1, 1, '[]') ON CONFLICT (id) DO NOTHING`,
    );
    const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
    if (Number(adminCount.rows[0].count) === 0 && process.env.ADMIN_PHONE_NUMBER) {
        const { rows } = await client.query(
            'SELECT id FROM users WHERE phone_number = $1',
            [process.env.ADMIN_PHONE_NUMBER.trim()],
        );
        if (!rows[0]) throw new Error('ADMIN_PHONE_NUMBER must match an existing registered account.');
        await client.query(
            "UPDATE users SET role = 'admin', auth_version = auth_version + 1 WHERE id = $1",
            [rows[0].id],
        );
    } else if (Number(adminCount.rows[0].count) === 0 && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const code = `BMG${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
        await client.query(
            `INSERT INTO users (id, full_name, phone_number, password_hash, role, country_code, referral_code, balance, status)
             VALUES ($1, 'BMG Admin', $2, $3, 'admin', 'RW', $4, 0, 'Active')
             ON CONFLICT (phone_number) DO NOTHING`,
            [uuid(), process.env.ADMIN_EMAIL, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), code],
        );
    }
}

async function ensureReady() {
    if (!readyPromise) {
        if (!process.env.DATABASE_URL) return Promise.reject(new Error('DATABASE_URL is required when BMG_DATABASE_DRIVER=postgres.'));
        readyPromise = transaction(async (client) => {
            await client.query('SELECT pg_advisory_xact_lock(702408112)');
            await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
            const applied = await client.query('SELECT version FROM schema_migrations WHERE version = $1', ['001_initial_schema']);
            if (!applied.rowCount) {
                const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '001_initial_schema.sql'), 'utf8');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', ['001_initial_schema']);
            }
            await seed(client);
        }).catch((error) => {
            readyPromise = null;
            throw error;
        });
    }
    return readyPromise;
}

async function getCountryConfig(client, code) {
    const country = COUNTRIES[String(code || '').toUpperCase()];
    if (!country) return null;
    const { rows } = await client.query('SELECT enabled, settings_json, products_json FROM country_configs WHERE country_code = $1', [country.code]);
    const row = rows[0];
    if (!row) return { ...country, enabled: false, settings: {}, products: {} };
    return {
        ...country,
        enabled: Boolean(row.enabled),
        settings: typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json,
        products: typeof row.products_json === 'string' ? JSON.parse(row.products_json) : row.products_json,
    };
}

async function getCountrySetting(client, code, key) {
    const config = await getCountryConfig(client, code);
    if (config && Object.hasOwn(config.settings, key)) return config.settings[key];
    const { rows } = await client.query('SELECT value_json FROM settings WHERE key = $1', [key]);
    if (!rows[0]) return null;
    return typeof rows[0].value_json === 'string' ? JSON.parse(rows[0].value_json) : rows[0].value_json;
}

function getCountryProduct(config, product) {
    const override = config?.products?.[product.id];
    return override ? { ...product, ...override } : product;
}

module.exports = { pool, uuid, transaction, transactionWith, ensureReady, getCountryConfig, getCountrySetting, getCountryProduct };
