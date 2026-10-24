// SQLite database setup using Node's built-in node:sqlite module (no native build step required).
// This file owns the schema for every domain area described in the BMG admin spec, plus seed data
// so the API is immediately usable in development. Replace/extend this file if you migrate to a
// different database engine later — the rest of the app only talks to the functions exported here.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { generateReferralCode, isReferralCodeFormat } = require('./utils/referralCodes');
const { COUNTRIES, COUNTRY_SETTING_KEYS } = require('./utils/countries');

const DB_PATH = process.env.BMG_DATABASE_PATH || path.join(__dirname, '..', 'bmg.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    phone_number TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin'
    country_code TEXT NOT NULL DEFAULT 'RW',
    referral_code TEXT UNIQUE,
    referred_by TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Active', -- Active | Suspended | Blocked
    must_reset_password INTEGER NOT NULL DEFAULT 0,
    auth_version INTEGER NOT NULL DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_page TEXT NOT NULL DEFAULT 'home',
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen_at);

CREATE TABLE IF NOT EXISTS referral_code_aliases (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promoter_comments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    promoter_id TEXT NOT NULL,
    comment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS promoter_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- deposit | withdrawal | adjustment | reward
    amount INTEGER NOT NULL,
    previous_balance INTEGER NOT NULL,
    new_balance INTEGER NOT NULL,
    reason TEXT,
    reference_id TEXT,
    performed_by TEXT, -- admin id, or 'system'/'user'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    method TEXT NOT NULL, -- mtn | airtel
    amount INTEGER NOT NULL,
    sender_phone TEXT,
    sender_name TEXT,
    payment_proof TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    method TEXT NOT NULL, -- mtn | airtel
    account_holder_name TEXT NOT NULL,
    mobile_money_number TEXT NOT NULL,
    bank_name TEXT,
    bank_account_number TEXT,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    received_amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    method TEXT NOT NULL, -- mtn | airtel
    account_holder_name TEXT NOT NULL,
    mobile_money_number TEXT NOT NULL,
    bank_name TEXT,
    bank_account_number TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL, -- chakin | giftcode | spinwin | custom-*
    title TEXT NOT NULL,
    description TEXT,
    instructions TEXT,
    reward INTEGER DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    daily_limit INTEGER,
    total_limit INTEGER,
    starts_at TEXT,
    ends_at TEXT,
    eligibility TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_claims (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gift_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    reward INTEGER NOT NULL,
    max_uses INTEGER,
    per_user_limit INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    country_code TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gift_code_redemptions (
    id TEXT PRIMARY KEY,
    gift_code_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spin_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    daily_spins INTEGER NOT NULL DEFAULT 1,
    starts_at TEXT,
    ends_at TEXT,
    prizes_json TEXT NOT NULL DEFAULT '[]' -- [{label, weight, amount}]
);

CREATE TABLE IF NOT EXISTS spin_results (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prize_label TEXT,
    amount INTEGER NOT NULL DEFAULT 0,
    reference_id TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reward_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    unit TEXT NOT NULL DEFAULT 'RWF',
    source TEXT NOT NULL,
    reference_id TEXT NOT NULL,
    previous_balance INTEGER NOT NULL DEFAULT 0,
    new_balance INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_bonuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UNLOCKED',
    deposit_required INTEGER NOT NULL DEFAULT 0,
    product_required INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    unlocked_at TEXT,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    price INTEGER NOT NULL DEFAULT 0,
    availability TEXT NOT NULL DEFAULT 'In Stock',
    image_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_earning_ledger (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    cycle_day INTEGER NOT NULL DEFAULT 1,
    next_credit_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    credited_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sponsors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    published INTEGER NOT NULL DEFAULT 1,
    publish_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    recipient_type TEXT NOT NULL, -- user | admin
    recipient_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    related_type TEXT,
    related_id TEXT,
    event_key TEXT UNIQUE,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commissions (
    level INTEGER PRIMARY KEY,
    percent REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_rewards (
    id TEXT PRIMARY KEY,
    required_invites INTEGER NOT NULL,
    reward INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS country_configs (
    country_code TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT NOT NULL DEFAULT '{}',
    products_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    previous_value TEXT,
    new_value TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chakin_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    check_in_date TEXT NOT NULL, -- YYYY-MM-DD, one row per user per day
    reward_amount INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, check_in_date)
);
`);

// Existing welcome bonuses were already credited at registration; make them immediately active.
db.exec("UPDATE user_bonuses SET status = 'UNLOCKED', unlocked_at = COALESCE(unlocked_at, datetime('now')) WHERE status = 'PENDING'");
db.exec("UPDATE reward_transactions SET status = 'completed' WHERE type = 'welcome_bonus' AND status = 'pending'");

// Safe column migration: node:sqlite has no ALTER ... ADD COLUMN IF NOT EXISTS.
try {
    db.exec('ALTER TABLE users ADD COLUMN points_balance INTEGER NOT NULL DEFAULT 0');
} catch (err) {
    // Column already exists from a previous run.
}
try { db.exec('ALTER TABLE users ADD COLUMN deposited_balance INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN bonus_balance INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN commission_balance INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN daily_income_balance INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN task_balance INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN product_purchase_blocked INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN login_blocked INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN deposits_blocked INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN withdrawals_blocked INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en'"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE users ADD COLUMN appearance TEXT NOT NULL DEFAULT 'system'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN promoter_id TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN promoter_comment TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE users ADD COLUMN promoter_assigned_at TEXT'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE users ADD COLUMN country_code TEXT NOT NULL DEFAULT 'RW'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE gift_codes ADD COLUMN country_code TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE audit_logs ADD COLUMN amount REAL'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE audit_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN commission_reserved INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN daily_income_reserved INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN task_reserved INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN bonus_reserved INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN bank_name TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawals ADD COLUMN bank_account_number TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawal_accounts ADD COLUMN bank_name TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE withdrawal_accounts ADD COLUMN bank_account_number TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE spin_results ADD COLUMN reference_id TEXT'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE spin_results ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN product_url TEXT'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE products ADD COLUMN card_color TEXT NOT NULL DEFAULT '#363b45'"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE products ADD COLUMN header_color TEXT NOT NULL DEFAULT '#73777d'"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE products ADD COLUMN button_color TEXT NOT NULL DEFAULT '#6b432b'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN percentage REAL NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN term_days INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN slots INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN starts_at TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN ends_at TEXT'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE products ADD COLUMN stock INTEGER NOT NULL DEFAULT 0"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE products ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE reward_transactions ADD COLUMN referred_user_id TEXT'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN investment_duration_days INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN daily_income_percent REAL NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN daily_income_amount INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec('ALTER TABLE products ADD COLUMN total_slots INTEGER NOT NULL DEFAULT 1000'); } catch (err) { /* already migrated */ }
db.exec('UPDATE products SET daily_income_amount = ROUND(price * daily_income_percent / 100) WHERE daily_income_amount = 0 AND daily_income_percent > 0');
try { db.exec('ALTER TABLE products ADD COLUMN total_income INTEGER NOT NULL DEFAULT 0'); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE settings ADD COLUMN created_at TEXT"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE settings ADD COLUMN updated_at TEXT"); } catch (err) { /* already migrated */ }
try { db.exec("ALTER TABLE gift_code_redemptions ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'"); } catch (err) { /* already migrated */ }
db.exec("UPDATE settings SET created_at = COALESCE(created_at, datetime('now')), updated_at = COALESCE(updated_at, datetime('now'))");

function uuid() {
    return crypto.randomUUID();
}

function migrateUserReferralCodes() {
    const users = db.prepare("SELECT id, referral_code FROM users WHERE role = 'user'").all();
    const findCode = db.prepare('SELECT 1 FROM users WHERE referral_code = ? UNION SELECT 1 FROM referral_code_aliases WHERE code = ? LIMIT 1');
    const saveAlias = db.prepare('INSERT OR IGNORE INTO referral_code_aliases (code, user_id) VALUES (?, ?)');
    const updateCode = db.prepare('UPDATE users SET referral_code = ? WHERE id = ?');

    db.exec('BEGIN IMMEDIATE');
    try {
        for (const user of users) {
            if (isReferralCodeFormat(user.referral_code)) continue;
            if (user.referral_code) saveAlias.run(user.referral_code, user.id);

            let referralCode;
            do {
                referralCode = generateReferralCode();
            } while (findCode.get(referralCode, referralCode));
            updateCode.run(referralCode, user.id);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

function seedIfEmpty() {
    const adminCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE role = ?').get('admin').c;
    if (adminCount === 0) {
        // Never hardcode the real admin password; read it from the environment (see server/.env.example).
        // If it isn't set, generate one at random and print it once so it isn't stored in source control.
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@mip.com';
        let adminPassword = process.env.ADMIN_PASSWORD;
        if (!adminPassword) {
            adminPassword = crypto.randomBytes(9).toString('base64url');
            console.warn('\n[BMG] No ADMIN_PASSWORD set. Generated a one-time password for the initial admin account:');
            console.warn(`[BMG] Email: ${adminEmail}  Password: ${adminPassword}`);
            console.warn('[BMG] Store this securely and set ADMIN_PASSWORD in server/.env for future restarts.\n');
        }
        const passwordHash = bcrypt.hashSync(adminPassword, 10);
        db.prepare(
            'INSERT INTO users (id, full_name, phone_number, password_hash, role, referral_code, balance, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        ).run(uuid(), 'BMG Admin', adminEmail, passwordHash, 'admin', 'ADMIN', 'Active');
    }

    const commissionCount = db.prepare('SELECT COUNT(*) as c FROM commissions').get().c;
    if (commissionCount === 0) {
        db.prepare('INSERT INTO commissions (level, percent) VALUES (?, ?)').run(1, 27);
        db.prepare('INSERT INTO commissions (level, percent) VALUES (?, ?)').run(2, 3);
        db.prepare('INSERT INTO commissions (level, percent) VALUES (?, ?)').run(3, 1);
    }

    const inviteRewardCount = db.prepare('SELECT COUNT(*) as c FROM invite_rewards').get().c;
    if (inviteRewardCount === 0) {
        [[5, 2500], [10, 10000], [20, 20000], [50, 25000], [100, 70000]].forEach(([required, reward]) => {
            db.prepare('INSERT INTO invite_rewards (id, required_invites, reward, enabled) VALUES (?, ?, ?, 1)').run(uuid(), required, reward);
        });
    }
    const configuredInviteMilestones = new Set(db.prepare('SELECT required_invites FROM invite_rewards').all().map((reward) => Number(reward.required_invites)));
    [[5, 2500], [10, 10000], [20, 20000], [50, 25000], [100, 70000]].forEach(([required, reward]) => {
        if (!configuredInviteMilestones.has(required)) {
            db.prepare('INSERT INTO invite_rewards (id, required_invites, reward, enabled) VALUES (?, ?, ?, 1)').run(uuid(), required, reward);
        }
    });

    const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
    if (taskCount === 0) {
        const defaults = [
            { slug: 'chakin', title: 'Chakin', description: 'Daily check-in activity.' },
            { slug: 'giftcode', title: 'Gift Code', description: 'Redeem a gift code.' },
            { slug: 'spinwin', title: 'Spin & Win', description: 'Spin for a chance to win rewards.' },
        ];
        defaults.forEach((task) => {
            db.prepare(
                'INSERT INTO tasks (id, slug, title, description, reward, enabled) VALUES (?, ?, ?, ?, 0, 1)',
            ).run(uuid(), task.slug, task.title, task.description);
        });
    }
    const coreTasks = [
        { slug: 'chakin', title: 'Chakin', description: 'Daily check-in activity.' },
        { slug: 'giftcode', title: 'Gift Code', description: 'Redeem a gift code.' },
        { slug: 'spinwin', title: 'Spin & Win', description: 'Spin for a chance to win rewards.' },
    ];
    coreTasks.forEach((task) => {
        db.prepare('INSERT OR IGNORE INTO tasks (id, slug, title, description, reward, enabled) VALUES (?, ?, ?, ?, 0, 1)')
            .run(uuid(), task.slug, task.title, task.description);
    });

    const spinConfigCount = db.prepare('SELECT COUNT(*) as c FROM spin_config').get().c;
    if (spinConfigCount === 0) {
        db.prepare('INSERT INTO spin_config (id, enabled, daily_spins, prizes_json) VALUES (1, 1, 1, ?)').run('[]');
    }

    const defaultSettings = {
        welcomeBonus: {
            enabled: false,
            type: 'fixed',
            amount: 0,
            minimumDeposit: 0,
            depositRequired: true,
            productPurchaseRequired: false,
            withdrawable: true,
            expiryDays: 0,
        },
        deposit: {
            enabled: true,
            mtn: { enabled: true, merchantName: 'Pending admin setup', merchantPhone: 'Pending admin setup', min: 6000, max: 5000000, instructions: '', verification: '' },
            airtel: { enabled: true, merchantName: 'Pending admin setup', merchantPhone: 'Pending admin setup', min: 3000, max: 5000000, instructions: '', verification: '' },
            instructions: '',
            proofRequired: true,
        },
        withdraw: {
            enabled: true,
            mtn: { enabled: true, min: 2000, max: 500000 },
            airtel: { enabled: true, min: 2000, max: 500000 },
            bank: { enabled: false, min: 2000, max: 500000 },
            feePercent: 5,
            minAmount: 2000,
            maxAmount: 500000,
            minimumBalance: 0,
            processingMessage: 'Payouts are processed after approval.',
            accountHolderNameRequired: true,
            availability: {
                enabled: true,
                days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
                openHour: 0,
                closeHour: 24,
                timezoneLabel: 'Kigali time',
            },
            bonusMessage: { enabled: false, amount: 0, text: '' },
        },
        investment: {
            enabled: true,
            minimumAmount: 6000,
            maximumAmount: 5000000,
            availableAmounts: [],
            durationDays: 0,
            dailyRatePercent: 0,
        },
        support: {
            telegramLink: '',
            telegramUsername: '',
            phone: '',
            whatsapp: '',
            email: '',
            message: 'Need help? Reach out to our support team.',
            availability: '',
            channelsEnabled: { telegram: false, whatsapp: false, phone: false, email: false },
        },
        branding: {
            brandName: 'BMG',
            tagline: 'Beyond My Goals',
            logoUrl: '',
            balanceImageUrl: 'Pasted Image',
            faviconUrl: '',
            primaryColor: '#3a6b7c',
            secondaryColor: '#2c5361',
            glassCardsEnabled: true,
        },
        coffeePlanet: {
            title: 'Home',
            subtitle: 'Select a service to get started',
            aboutTitle: 'About Us',
            aboutText: 'We connect our members with carefully selected products and offer clear account tools to manage their activity.\n\nMembers can track their plans, invite friends, and review available tasks and account transactions from one place.',
            images: [
                { src: '/assets/coffee-slides/coffee-brewing.jpg', caption: 'Freshly Brewed Coffee' },
                { src: '/assets/coffee-slides/coffee-beans.jpg', caption: 'Premium Coffee Beans' },
                { src: '/assets/coffee-slides/coffee-cafe.jpg', caption: 'Coffee Moments' },
                { src: '/assets/coffee-slides/coffee-selection.jpg', caption: 'A World of Coffee' },
                { src: '/assets/coffee-slides/iced-coffee.jpg', caption: 'A Refreshing Coffee Break' },
            ],
        },
        chakin: {
            enabled: true,
            reward: 0,
            cooldownHours: 24,
            maxCheckins: 0,
            startDate: '',
            endDate: '',
            timezone: 'Africa/Kigali',
            timezoneLabel: 'Kigali time',
        },
        giftcode: {
            enabled: true,
        },
    };

    Object.entries(defaultSettings).forEach(([key, value]) => {
        const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
        if (!existing) {
            db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(key, JSON.stringify(value));
        }
    });

}

migrateUserReferralCodes();
seedIfEmpty();

const legacySettings = Object.fromEntries(
    db.prepare('SELECT key, value_json FROM settings').all().map((row) => [row.key, JSON.parse(row.value_json)]),
);
legacySettings.commissions = db.prepare('SELECT level, percent FROM commissions ORDER BY level ASC').all();
legacySettings.inviteRewards = db.prepare('SELECT id, required_invites AS requiredInvites, reward, enabled FROM invite_rewards ORDER BY required_invites ASC').all()
    .map((reward) => ({ ...reward, enabled: Boolean(reward.enabled) }));
const countrySettings = Object.fromEntries(
    COUNTRY_SETTING_KEYS.filter((key) => Object.hasOwn(legacySettings, key)).map((key) => [key, legacySettings[key]]),
);
const legacyProducts = Object.fromEntries(
    db.prepare('SELECT * FROM products').all().map((product) => [product.id, {
        price: product.price,
        stock: product.stock,
        total_slots: product.total_slots,
        status: product.status,
        enabled: Boolean(product.enabled),
        investment_duration_days: product.investment_duration_days,
        daily_income_amount: product.daily_income_amount,
        daily_income_percent: product.daily_income_percent,
        total_income: product.total_income,
    }]),
);
const saveCountryConfig = db.prepare(`
    INSERT OR IGNORE INTO country_configs (country_code, enabled, settings_json, products_json)
    VALUES (?, 1, ?, ?)
`);
for (const country of Object.values(COUNTRIES)) {
    saveCountryConfig.run(country.code, JSON.stringify(countrySettings), JSON.stringify(legacyProducts));
}

const countryWithdrawalConfigs = db.prepare('SELECT country_code, settings_json FROM country_configs').all();
const saveCountrySettings = db.prepare("UPDATE country_configs SET settings_json = ?, updated_at = datetime('now') WHERE country_code = ?");
db.exec('BEGIN IMMEDIATE');
try {
    for (const row of countryWithdrawalConfigs) {
        const settings = JSON.parse(row.settings_json);
        const withdrawal = settings.withdraw;
        if (!withdrawal || typeof withdrawal !== 'object' || Array.isArray(withdrawal)) continue;
        const minimum = Number.isSafeInteger(Number(withdrawal.minAmount)) ? Number(withdrawal.minAmount) : 0;
        const maximum = Number.isSafeInteger(Number(withdrawal.maxAmount)) ? Number(withdrawal.maxAmount) : Number.MAX_SAFE_INTEGER;
        let changed = false;
        for (const [method, enabled] of [['mtn', true], ['airtel', true], ['bank', false]]) {
            if (withdrawal[method]) continue;
            withdrawal[method] = { enabled, min: minimum, max: maximum };
            changed = true;
        }
        if (changed) saveCountrySettings.run(JSON.stringify(settings), row.country_code);
    }
    db.exec('COMMIT');
} catch (error) {
    db.exec('ROLLBACK');
    throw error;
}

const depositSetting = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('deposit');
if (depositSetting) {
    const depositValue = JSON.parse(depositSetting.value_json);
    let depositChanged = false;
    for (const method of ['mtn', 'airtel']) {
        if (!depositValue[method]) continue;
        if (!Object.prototype.hasOwnProperty.call(depositValue[method], 'instructions')) { depositValue[method].instructions = ''; depositChanged = true; }
        if (!Object.prototype.hasOwnProperty.call(depositValue[method], 'verification')) { depositValue[method].verification = ''; depositChanged = true; }
    }
    if (depositChanged) db.prepare("UPDATE settings SET value_json = ?, updated_at = datetime('now') WHERE key = 'deposit'").run(JSON.stringify(depositValue));
}

// Keep the development Admin login aligned with server/.env even if the account was seeded earlier.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const configuredAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
    if (configuredAdmin) {
        db.prepare('UPDATE users SET phone_number = ?, password_hash = ?, status = \'Active\' WHERE id = ?')
            .run(process.env.ADMIN_EMAIL, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), configuredAdmin.id);
    }
}

const spinSetting = db.prepare('SELECT prizes_json FROM spin_config WHERE id = 1').get();
if (spinSetting && (!spinSetting.prizes_json || spinSetting.prizes_json === '[]')) {
    db.prepare('UPDATE spin_config SET prizes_json = ? WHERE id = 1').run(JSON.stringify([
        { label: '10 Points', weight: 1, points: 10 },
        { label: '25 Points', weight: 1, points: 25 },
        { label: '50 Points', weight: 1, points: 50 },
        { label: 'Try Again', weight: 1, points: 0 },
    ]));
}

const brandingSetting = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('branding');
if (brandingSetting) {
    const brandingValue = JSON.parse(brandingSetting.value_json);
    if (!Object.prototype.hasOwnProperty.call(brandingValue, 'balanceImageUrl')) {
        brandingValue.balanceImageUrl = 'Pasted Image';
        db.prepare('UPDATE settings SET value_json = ? WHERE key = ?').run(JSON.stringify(brandingValue), 'branding');
    }
}

module.exports = { db, uuid };
