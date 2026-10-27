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
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_page TEXT NOT NULL DEFAULT 'home',
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen_at);

CREATE TABLE IF NOT EXISTS referral_code_aliases (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS promoter_comments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    promoter_id TEXT NOT NULL,
    comment TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS promoter_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS promoter_events (
    id BIGSERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_promoter_events_created_at ON promoter_events(created_at);

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    commission_reserved INTEGER NOT NULL DEFAULT 0,
    daily_income_reserved INTEGER NOT NULL DEFAULT 0,
    task_reserved INTEGER NOT NULL DEFAULT 0,
    bonus_reserved INTEGER NOT NULL DEFAULT 0,
    bonus_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | paid
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS withdrawal_accounts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    method TEXT NOT NULL, -- mtn | airtel
    account_holder_name TEXT NOT NULL,
    mobile_money_number TEXT NOT NULL,
    bank_name TEXT,
    bank_account_number TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    eligibility TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS task_claims (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS gift_codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    reward INTEGER NOT NULL,
    max_uses INTEGER,
    per_user_limit INTEGER NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ,
    enabled INTEGER NOT NULL DEFAULT 1,
    country_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS gift_code_redemptions (
    id TEXT PRIMARY KEY,
    gift_code_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS spin_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 1,
    daily_spins INTEGER NOT NULL DEFAULT 1,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    prizes_json TEXT NOT NULL DEFAULT '[]' -- [{label, weight, amount}]
);

CREATE TABLE IF NOT EXISTS spin_results (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prize_label TEXT,
    amount INTEGER NOT NULL DEFAULT 0,
    reference_id TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS user_bonuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'UNLOCKED',
    deposit_required INTEGER NOT NULL DEFAULT 0,
    product_required INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ,
    unlocked_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS product_purchases (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    price INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS product_earning_ledger (
    id TEXT PRIMARY KEY,
    purchase_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0,
    cycle_day INTEGER NOT NULL DEFAULT 1,
    next_credit_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    credited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS sponsors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    logo_url TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    published INTEGER NOT NULL DEFAULT 1,
    publish_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
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
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS commissions (
    level INTEGER PRIMARY KEY,
    percent REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS team_levels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    requirement INTEGER NOT NULL DEFAULT 0,
    benefit TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    updated_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    admin_id TEXT,
    action TEXT NOT NULL,
    target TEXT,
    previous_value TEXT,
    new_value TEXT,
    status TEXT NOT NULL DEFAULT 'success',
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE TABLE IF NOT EXISTS chakin_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    check_in_date TEXT NOT NULL, -- YYYY-MM-DD, one row per user per day
    reward_amount INTEGER NOT NULL,
    reference_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(user_id, check_in_date)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS deposited_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_income_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS task_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS points_balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_level_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS product_purchase_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deposits_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS withdrawals_blocked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS appearance TEXT NOT NULL DEFAULT 'system';
ALTER TABLE users ADD COLUMN IF NOT EXISTS promoter_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS promoter_comment TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS promoter_assigned_at TIMESTAMPTZ;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE gift_codes ADD COLUMN IF NOT EXISTS country_code TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS amount REAL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS commission_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS daily_income_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS task_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bonus_reserved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bonus_id TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE withdrawal_accounts ADD COLUMN IF NOT EXISTS bank_name TEXT;
ALTER TABLE withdrawal_accounts ADD COLUMN IF NOT EXISTS bank_account_number TEXT;
ALTER TABLE spin_results ADD COLUMN IF NOT EXISTS reference_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS product_url TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS card_color TEXT NOT NULL DEFAULT '#363b45';
ALTER TABLE products ADD COLUMN IF NOT EXISTS header_color TEXT NOT NULL DEFAULT '#73777d';
ALTER TABLE products ADD COLUMN IF NOT EXISTS button_color TEXT NOT NULL DEFAULT '#6b432b';
ALTER TABLE products ADD COLUMN IF NOT EXISTS percentage REAL NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS term_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS slots INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
ALTER TABLE products ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
ALTER TABLE reward_transactions ADD COLUMN IF NOT EXISTS referred_user_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS investment_duration_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS daily_income_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS daily_income_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_slots INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_income INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE spin_results ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';