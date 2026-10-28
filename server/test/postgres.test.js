const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { once } = require('node:events');
const { ensureReady, pool, transactionWith } = require('../src/postgres/store');
const { signToken } = require('../src/auth');
const { router: promotersRouter } = require('../src/postgres/routes/promoters');
const { router: depositsRouter } = require('../src/postgres/routes/deposits');
const { router: withdrawalsRouter } = require('../src/postgres/routes/withdrawals');
const { router: productsRouter } = require('../src/postgres/routes/products');
const { router: authRouter } = require('../src/postgres/routes/auth');
const { router: countriesRouter } = require('../src/postgres/routes/countries');
const { router: tasksRouter } = require('../src/postgres/routes/tasks');
const { router: usersRouter } = require('../src/postgres/routes/users');
const { router: announcementsRouter } = require('../src/postgres/routes/announcements');
const { router: auditRouter } = require('../src/postgres/routes/audit');
const { router: notificationsRouter } = require('../src/postgres/routes/notifications');
const { router: overviewRouter } = require('../src/postgres/routes/overview');
const { router: presenceRouter } = require('../src/postgres/routes/presence');
const { router: sponsorsRouter } = require('../src/postgres/routes/sponsors');
const { router: settingsRouter } = require('../src/postgres/routes/settings');
const { router: teamRouter } = require('../src/postgres/routes/team');
const { validateCountryInput } = require('../src/postgres/routes/countries');
const { validateSetting } = require('../src/postgres/settingsValidation');
const { creditReferralCommissions } = require('../src/postgres/routes/deposits');
const { getEligibleBonus } = require('../src/postgres/routes/withdrawals');
const { validateProduct } = require('../src/postgres/routes/products');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_initial_schema.sql'), 'utf8');

function queryPGlite(database, sql, params) {
    if (params === undefined && /;\s*\S/.test(sql.trim())) {
        return database.exec(sql).then(() => ({ rows: [], rowCount: null }));
    }
    return database.query(sql, params);
}

test('PostgreSQL transaction helper commits and always releases its client', async () => {
    const calls = [];
    const client = {
        async query(sql) { calls.push(sql); },
        release() { calls.push('RELEASE'); },
    };
    const result = await transactionWith({ connect: async () => client }, async () => 'ok');
    assert.equal(result, 'ok');
    assert.deepEqual(calls, ['BEGIN', 'COMMIT', 'RELEASE']);
});

test('PostgreSQL transaction helper rolls back failed work and releases its client', async () => {
    const calls = [];
    const client = {
        async query(sql) { calls.push(sql); },
        release() { calls.push('RELEASE'); },
    };
    await assert.rejects(
        transactionWith({ connect: async () => client }, async () => { throw new Error('failure'); }),
        /failure/,
    );
    assert.deepEqual(calls, ['BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('initial migration covers every existing API domain and async timestamp columns', () => {
    for (const table of [
        'users', 'transactions', 'deposits', 'withdrawals', 'withdrawal_accounts',
        'products', 'product_purchases', 'product_earning_ledger', 'tasks', 'task_claims',
        'gift_codes', 'gift_code_redemptions', 'spin_config', 'spin_results',
        'user_bonuses', 'notifications', 'settings', 'country_configs', 'audit_logs',
        'password_reset_tokens', 'user_presence', 'promoter_profiles', 'promoter_comments', 'promoter_events', 'team_levels',
    ]) {
        assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
    assert.match(migration, /next_credit_at TIMESTAMPTZ NOT NULL/);
    assert.match(migration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'/);
    assert.match(migration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS appearance TEXT NOT NULL DEFAULT 'system'/);
    assert.match(migration, /ALTER TABLE users ADD COLUMN IF NOT EXISTS points_balance INTEGER NOT NULL DEFAULT 0/);
    assert.match(migration, /ALTER TABLE products ADD COLUMN IF NOT EXISTS card_color TEXT NOT NULL DEFAULT '#363b45'/);
    assert.match(migration, /ALTER TABLE spin_results ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'/);
    assert.match(migration, /ALTER TABLE settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'postgres', 'store.js'), 'utf8'), /CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.doesNotMatch(migration, /datetime\(|INSERT OR IGNORE|PRAGMA/);
});

test('every SQLite API route has an equivalent PostgreSQL route', () => {
    const sqliteDirectory = path.join(__dirname, '..', 'src', 'routes');
    const postgresDirectory = path.join(__dirname, '..', 'src', 'postgres', 'routes');
    const sqliteFiles = fs.readdirSync(sqliteDirectory).filter((name) => name.endsWith('.js')).sort();
    const postgresFiles = fs.readdirSync(postgresDirectory).filter((name) => name.endsWith('.js')).sort();
    assert.deepEqual(postgresFiles, sqliteFiles);

    const routesFor = (source) => [...source.matchAll(/router\.(get|post|put|patch|delete)\(['"]([^'"]+)['"]/g)]
        .map((match) => `${match[1].toUpperCase()} ${match[2]}`)
        .sort();
    for (const file of sqliteFiles) {
        const sqliteSource = fs.readFileSync(path.join(sqliteDirectory, file), 'utf8');
        const postgresSource = fs.readFileSync(path.join(postgresDirectory, file), 'utf8');
        assert.deepEqual(routesFor(postgresSource), routesFor(sqliteSource), `${file} endpoint coverage differs`);
    }
});

test('initial migration applies to a disposable PostgreSQL database', async () => {
    const database = new PGlite();
    try {
        await database.exec(migration);
        await database.exec(migration);
        const { rows } = await database.query(
            "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        );
        assert.equal(rows[0].count, 32);
        await database.query(
            "INSERT INTO country_configs (country_code, enabled, settings_json, products_json) VALUES ($1, $2, $3, $4)",
            ['RW', 1, '{}', '{}'],
        );
        const { rows: country } = await database.query('SELECT country_code, enabled FROM country_configs WHERE country_code = $1', ['RW']);
        assert.equal(country[0].country_code, 'RW');
        assert.equal(country[0].enabled, 1);
        await database.query(
            "INSERT INTO users (id, full_name, phone_number, password_hash) VALUES ('test-user', 'Test User', '0780000000', 'hash')",
        );
        await database.query("UPDATE users SET language = 'rw', appearance = 'dark' WHERE id = 'test-user'");
        const { rows: preferences } = await database.query('SELECT language, appearance FROM users WHERE id = $1', ['test-user']);
        assert.deepEqual(preferences[0], { language: 'rw', appearance: 'dark' });
        await database.query(
            "INSERT INTO users (id, full_name, phone_number, password_hash, balance) VALUES ('referrer', 'Referrer', '0780000001', 'hash', 100)",
        );
        await database.query("UPDATE users SET referred_by = 'referrer' WHERE id = 'test-user'");
        await database.query(
            'UPDATE country_configs SET settings_json = $1 WHERE country_code = $2',
            [JSON.stringify({ commissions: [{ level: 1, percent: 10 }] }), 'RW'],
        );
        await database.exec('BEGIN');
        await creditReferralCommissions(database, 'test-user', 100, 'deposit-1');
        await creditReferralCommissions(database, 'test-user', 100, 'deposit-1');
        await database.exec('COMMIT');
        const { rows: referralBalances } = await database.query(
            "SELECT balance, commission_balance FROM users WHERE id = 'referrer'",
        );
        assert.deepEqual(referralBalances[0], { balance: 110, commission_balance: 10 });
        await database.query(
            "INSERT INTO products (id, name, price) VALUES ('product-1', 'Test product', 100)",
        );
        await database.query(
            "INSERT INTO product_purchases (id, user_id, product_id, price, status) VALUES ('purchase-1', 'test-user', 'product-1', 100, 'completed')",
        );
        await database.query(
            "INSERT INTO user_bonuses (id, user_id, amount, status) VALUES ('bonus-1', 'test-user', 25, 'UNLOCKED')",
        );
        await database.query(
            'UPDATE country_configs SET settings_json = $1 WHERE country_code = $2',
            [JSON.stringify({ welcomeBonus: { withdrawable: true } }), 'RW'],
        );
        assert.equal(await getEligibleBonus(database, 'test-user', 'RW'), 25);
        await database.query(
            'UPDATE country_configs SET settings_json = $1 WHERE country_code = $2',
            [JSON.stringify({ welcomeBonus: { withdrawable: false } }), 'RW'],
        );
        assert.equal(await getEligibleBonus(database, 'test-user', 'RW'), 0);
        await database.query(
            "INSERT INTO settings (key, value_json, created_at, updated_at) VALUES ('test', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        );
        await database.query(
            "INSERT INTO team_levels (id, name, requirement) VALUES ('starter', 'Starter', 0)",
        );
    } finally {
        await database.close();
    }
});

test('PostgreSQL startup applies migrations and seeds defaults on an empty database', async () => {
    const database = new PGlite();
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalAdminPhoneNumber = process.env.ADMIN_PHONE_NUMBER;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    process.env.DATABASE_URL = 'postgres://test.invalid/bmg';
    process.env.ADMIN_PHONE_NUMBER = '0788830555';

    try {
        await database.exec(migration);
        await database.query(
            "INSERT INTO users (id, full_name, phone_number, password_hash) VALUES ('bootstrap-admin', 'Admin Account', '0788830555', 'existing-hash')",
        );
        await ensureReady();
        const { rows: migrations } = await database.query('SELECT version FROM schema_migrations');
        const { rows: settings } = await database.query('SELECT COUNT(*)::int AS count FROM settings');
        const { rows: countries } = await database.query('SELECT COUNT(*)::int AS count FROM country_configs');
        const { rows: admin } = await database.query(
            "SELECT role, password_hash FROM users WHERE phone_number = '0788830555'",
        );
        assert.deepEqual(migrations, [{ version: '001_initial_schema' }]);
        assert.ok(settings[0].count >= 1);
        assert.ok(countries[0].count > 0);
        assert.deepEqual(admin[0], { role: 'admin', password_hash: 'existing-hash' });
    } finally {
        pool.query = originalQuery;
        pool.connect = originalConnect;
        if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalDatabaseUrl;
        if (originalAdminPhoneNumber === undefined) delete process.env.ADMIN_PHONE_NUMBER;
        else process.env.ADMIN_PHONE_NUMBER = originalAdminPhoneNumber;
        await database.close();
    }
});

test('PostgreSQL promoter routes support assignment, controls, comments, and live events', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.exec(`
        INSERT INTO users (id, full_name, phone_number, password_hash, role)
        VALUES ('admin-1', 'Admin', 'admin-test', 'hash', 'admin'),
               ('member-1', 'Member', 'member-test', 'hash', 'user');
    `);

    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });

    const app = express();
    app.use(express.json());
    app.use('/api/promoters', promotersRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/promoters`;
    const adminToken = signToken({ id: 'admin-1', role: 'admin', phone_number: 'admin-test', auth_version: 0 });
    const memberToken = signToken({ id: 'member-1', role: 'user', phone_number: 'member-test', auth_version: 0 });
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const memberHeaders = { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' };
    let eventController;

    try {
        const createdResponse = await fetch(baseUrl, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ name: 'Integration promoter' }),
        });
        assert.equal(createdResponse.status, 201);
        const { promoter } = await createdResponse.json();

        const assignmentResponse = await fetch(`${baseUrl}/users/member-1`, {
            method: 'PUT',
            headers: adminHeaders,
            body: JSON.stringify({ promoterId: promoter.id, comment: 'assigned' }),
        });
        assert.equal(assignmentResponse.status, 200);

        const restrictionResponse = await fetch(`${baseUrl}/${promoter.id}/control/restriction`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ key: 'deposits_blocked', blocked: true }),
        });
        assert.equal(restrictionResponse.status, 200);

        const balanceResponse = await fetch(`${baseUrl}/${promoter.id}/control/balance`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ amount: 100, direction: 'add', reason: 'integration test' }),
        });
        assert.equal(balanceResponse.status, 200);
        assert.equal((await balanceResponse.json()).balance, 100);

        const commentResponse = await fetch(`${baseUrl}/${promoter.id}/comments`, {
            method: 'POST',
            headers: memberHeaders,
            body: JSON.stringify({ comment: 'First integration comment' }),
        });
        assert.equal(commentResponse.status, 201);

        const meResponse = await fetch(`${baseUrl}/me`, { headers: memberHeaders });
        assert.equal((await meResponse.json()).promoter.id, promoter.id);

        eventController = new AbortController();
        const eventResponse = await fetch(`${baseUrl}/events?token=${encodeURIComponent(memberToken)}`, {
            signal: eventController.signal,
        });
        assert.equal(eventResponse.status, 200);
        const reader = eventResponse.body.getReader();
        const initialEvent = await reader.read();
        assert.match(new TextDecoder().decode(initialEvent.value), /connected/);

        const liveCommentResponse = await fetch(`${baseUrl}/${promoter.id}/comments`, {
            method: 'POST',
            headers: memberHeaders,
            body: JSON.stringify({ comment: 'Live event integration comment' }),
        });
        assert.equal(liveCommentResponse.status, 201);

        let eventData = '';
        const deadline = Date.now() + 5000;
        while (!eventData.includes('Live event integration comment') && Date.now() < deadline) {
            const chunk = await Promise.race([
                reader.read(),
                new Promise((resolve) => setTimeout(() => resolve({ done: true }), 1500)),
            ]);
            if (chunk.done) continue;
            eventData += new TextDecoder().decode(chunk.value);
        }
        assert.match(eventData, /Live event integration comment/);
        await reader.cancel();

        await database.query("UPDATE users SET auth_version = auth_version + 1 WHERE id = 'member-1'");
        const revokedEventsResponse = await fetch(`${baseUrl}/events?token=${encodeURIComponent(memberToken)}`);
        assert.equal(revokedEventsResponse.status, 401);
    } finally {
        eventController?.abort();
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('PostgreSQL money routes preserve balances across purchases, deposits, and withdrawal rejection', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.query(
        `INSERT INTO users (id, full_name, phone_number, password_hash, role, balance)
         VALUES ('admin-money', 'Admin', 'admin-money-test', 'hash', 'admin', 0),
                ('member-money', 'Member', 'member-money-test', 'hash', 'user', 500)`,
    );
    await database.query(
        `INSERT INTO country_configs (country_code, enabled, settings_json, products_json)
         VALUES ('RW', 1, $1, '{}')`,
        [JSON.stringify({
            deposit: { enabled: true, mtn: { enabled: true, min: 1, max: 1000 }, proofRequired: false },
            withdraw: { enabled: true, mtn: { enabled: true, min: 1, max: 1000 }, feePercent: 0, minimumBalance: 0, availability: { enabled: false } },
            welcomeBonus: { withdrawable: true, minimumDeposit: 0 },
        })],
    );
    await database.query(
        `INSERT INTO products
         (id, name, category, price, stock, total_slots, status, availability, enabled)
         VALUES ('money-product', 'Product', 'test', 100, 5, 5, 'active', 'In Stock', 1)`,
    );
    await database.query(
        `INSERT INTO withdrawal_accounts
         (id, user_id, method, account_holder_name, mobile_money_number)
         VALUES ('account-money', 'member-money', 'mtn', 'Member', '0781234567')`,
    );

    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    const app = express();
    app.use(express.json());
    app.use('/api/deposits', depositsRouter);
    app.use('/api/withdrawals', withdrawalsRouter);
    app.use('/api/products', productsRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const adminToken = signToken({ id: 'admin-money', role: 'admin', phone_number: 'admin-money-test', auth_version: 0 });
    const memberToken = signToken({ id: 'member-money', role: 'user', phone_number: 'member-money-test', auth_version: 0 });
    const headers = { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' };
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };

    try {
        const purchaseResponse = await fetch(`${baseUrl}/products/money-product/purchase`, {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
        });
        assert.equal(purchaseResponse.status, 201);
        const { rows: purchaseBalances } = await database.query(
            "SELECT balance FROM users WHERE id = 'member-money'",
        );
        assert.equal(purchaseBalances[0].balance, 400);

        const invalidDeposit = await fetch(`${baseUrl}/deposits`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ method: 'mtn', amount: 1000.6, senderPhone: '0781234567' }),
        });
        assert.equal(invalidDeposit.status, 400);

        const depositResponse = await fetch(`${baseUrl}/deposits`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ method: 'mtn', amount: 20, senderPhone: '0781234567' }),
        });
        assert.equal(depositResponse.status, 201);
        const { deposit } = await depositResponse.json();
        const approvalResponse = await fetch(`${baseUrl}/deposits/${deposit.id}/approve`, {
            method: 'POST',
            headers: adminHeaders,
        });
        assert.equal(approvalResponse.status, 200);
        const duplicateApproval = await fetch(`${baseUrl}/deposits/${deposit.id}/approve`, {
            method: 'POST',
            headers: adminHeaders,
        });
        assert.equal(duplicateApproval.status, 409);

        await database.query(
            `INSERT INTO user_bonuses (id, user_id, amount, status)
             VALUES ('withdrawal-bonus', 'member-money', 40, 'UNLOCKED')`,
        );
        await database.query(
            "UPDATE users SET balance = balance + 40, bonus_balance = bonus_balance + 40 WHERE id = 'member-money'",
        );
        const withdrawalResponse = await fetch(`${baseUrl}/withdrawals`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ amount: 30 }),
        });
        assert.equal(withdrawalResponse.status, 201);
        const { withdrawal } = await withdrawalResponse.json();
        const { rows: reserved } = await database.query(
            `SELECT w.bonus_id, w.bonus_reserved, u.balance, u.bonus_balance, b.amount AS bonus_amount
             FROM withdrawals w JOIN users u ON u.id = w.user_id
             JOIN user_bonuses b ON b.id = w.bonus_id WHERE w.id = $1`,
            [withdrawal.id],
        );
        assert.deepEqual(reserved[0], {
            bonus_id: 'withdrawal-bonus',
            bonus_reserved: 30,
            balance: 430,
            bonus_balance: 10,
            bonus_amount: 10,
        });
        await database.query(
            `INSERT INTO user_bonuses (id, user_id, amount, status)
             VALUES ('newer-bonus', 'member-money', 5, 'PENDING')`,
        );
        const rejectionResponse = await fetch(`${baseUrl}/withdrawals/${withdrawal.id}/reject`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ reason: 'integration test' }),
        });
        assert.equal(rejectionResponse.status, 200);
        const { rows: refunded } = await database.query(
            `SELECT u.balance, u.bonus_balance,
                    (SELECT amount FROM user_bonuses WHERE id = 'withdrawal-bonus') AS reserved_bonus,
                    (SELECT amount FROM user_bonuses WHERE id = 'newer-bonus') AS newer_bonus
             FROM users u WHERE u.id = 'member-money'`,
        );
        assert.deepEqual(refunded[0], {
            balance: 460,
            bonus_balance: 40,
            reserved_bonus: 40,
            newer_bonus: 5,
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('PostgreSQL country discovery and registration work against the database API', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.query(
        `INSERT INTO country_configs (country_code, enabled, settings_json, products_json)
         VALUES ('RW', 1, $1, '{}')`,
        [JSON.stringify({ welcomeBonus: { enabled: false, type: 'fixed', amount: 0 } })],
    );
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    app.use('/api/countries', countriesRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

    try {
        const countriesResponse = await fetch(`${baseUrl}/countries`);
        assert.equal(countriesResponse.status, 200);
        const { countries } = await countriesResponse.json();
        assert.equal(countries.find(({ code }) => code === 'RW').enabled, true);

        const registrationResponse = await fetch(`${baseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Test Member',
                phoneNumber: '0781234567',
                password: '12345',
                confirmPassword: '12345',
                countryCode: 'RW',
            }),
        });
        assert.equal(registrationResponse.status, 201);
        const { user } = await registrationResponse.json();
        assert.equal(user.countryCode, 'RW');
        assert.equal(user.phoneNumber, '0781234567');

        const loginResponse = await fetch(`${baseUrl}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phoneNumber: '0781234567', password: '12345', countryCode: 'RW' }),
        });
        assert.equal(loginResponse.status, 200);
        assert.ok((await loginResponse.json()).token);

        const duplicateResponse = await fetch(`${baseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fullName: 'Duplicate Member',
                phoneNumber: '0781234567',
                password: '12345',
                confirmPassword: '12345',
                countryCode: 'RW',
            }),
        });
        assert.equal(duplicateResponse.status, 409);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('PostgreSQL task rewards are credited once and tracked in the wallet ledger', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.query(
        `INSERT INTO users (id, full_name, phone_number, password_hash, role, balance)
         VALUES ('member-task', 'Member', 'member-task-test', 'hash', 'user', 100)`,
    );
    await database.query(
        `INSERT INTO country_configs (country_code, enabled, settings_json, products_json)
         VALUES ('RW', 1, $1, '{}')`,
        [JSON.stringify({
            chakin: { enabled: true, reward: 25, cooldownHours: 24, maxCheckins: 1 },
            giftcode: { enabled: true },
        })],
    );
    await database.query(
        `INSERT INTO gift_codes (id, code, reward, max_uses, per_user_limit, enabled)
         VALUES ('gift-task', 'VALID30', 30, 1, 1, 1)`,
    );

    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    const app = express();
    app.use(express.json());
    app.use('/api/tasks', tasksRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/tasks`;
    const token = signToken({ id: 'member-task', role: 'user', phone_number: 'member-task-test', auth_version: 0 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
        const checkinResponse = await fetch(`${baseUrl}/chakin/checkin`, { method: 'POST', headers });
        assert.equal(checkinResponse.status, 200);
        assert.equal((await checkinResponse.json()).reward, 25);
        const duplicateCheckin = await fetch(`${baseUrl}/chakin/check-in`, { method: 'POST', headers });
        assert.equal(duplicateCheckin.status, 409);

        const redemptionResponse = await fetch(`${baseUrl}/giftcode/redeem`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ code: ' valid30 ' }),
        });
        assert.equal(redemptionResponse.status, 200);
        assert.equal((await redemptionResponse.json()).reward, 30);
        const duplicateRedemption = await fetch(`${baseUrl}/gift-codes/redeem`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ code: 'VALID30' }),
        });
        assert.equal(duplicateRedemption.status, 409);

        const { rows: account } = await database.query(
            "SELECT balance, task_balance FROM users WHERE id = 'member-task'",
        );
        assert.deepEqual(account[0], { balance: 155, task_balance: 55 });
        const { rows: rewards } = await database.query(
            "SELECT type, amount FROM reward_transactions WHERE user_id = 'member-task' ORDER BY type",
        );
        assert.deepEqual(rewards, [
            { type: 'chakin', amount: 25 },
            { type: 'gift_code', amount: 30 },
        ]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('PostgreSQL admin user directory, profile, and balance adjustment endpoints work', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.query(
        `INSERT INTO users (id, full_name, phone_number, password_hash, role, balance)
         VALUES ('admin-users', 'Admin', 'admin-users-test', 'hash', 'admin', 0),
                ('member-users', 'Directory Member', 'member-users-test', 'hash', 'user', 100)`,
    );
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    const app = express();
    app.use(express.json());
    app.use('/api/users', usersRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/users`;
    const adminToken = signToken({ id: 'admin-users', role: 'admin', phone_number: 'admin-users-test', auth_version: 0 });
    const memberToken = signToken({ id: 'member-users', role: 'user', phone_number: 'member-users-test', auth_version: 0 });
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const memberHeaders = { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' };

    try {
        const directoryResponse = await fetch(`${baseUrl}/directory?search=Directory%20Member&country=RW`, {
            headers: adminHeaders,
        });
        assert.equal(directoryResponse.status, 200);
        const directory = await directoryResponse.json();
        assert.equal(directory.total, 1);
        assert.equal(directory.users[0].id, 'member-users');

        const adjustmentResponse = await fetch(`${baseUrl}/member-users/adjust-balance`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ amount: 50, direction: 'add', reason: 'test credit' }),
        });
        assert.equal(adjustmentResponse.status, 200);
        assert.equal((await adjustmentResponse.json()).newBalance, 150);

        const negativeAdjustment = await fetch(`${baseUrl}/member-users/adjust-balance`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ amount: 200, direction: 'remove', reason: 'test debit' }),
        });
        assert.equal(negativeAdjustment.status, 400);

        const profileResponse = await fetch(`${baseUrl}/member-users`, { headers: adminHeaders });
        assert.equal(profileResponse.status, 200);
        const profile = await profileResponse.json();
        assert.equal(profile.user.balance, 150);
        assert.equal(profile.financial.transactions.length, 1);
        const historyResponse = await fetch(`${baseUrl}/history?category=all`, { headers: memberHeaders });
        assert.equal(historyResponse.status, 200);
        assert.equal((await historyResponse.json()).items.length, 1);

        const { rows: history } = await database.query(
            "SELECT type, amount, previous_balance, new_balance FROM transactions WHERE user_id = 'member-users'",
        );
        assert.deepEqual(history[0], {
            type: 'adjustment',
            amount: 50,
            previous_balance: 100,
            new_balance: 150,
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('PostgreSQL settings, announcements, sponsors, notifications, team, presence, and overview APIs work', async () => {
    const database = new PGlite();
    await database.exec(migration);
    await database.query(
        `INSERT INTO users (id, full_name, phone_number, password_hash, role)
         VALUES ('admin-common', 'Admin', 'admin-common-test', 'hash', 'admin'),
                ('member-common', 'Member', 'member-common-test', 'hash', 'user'),
                ('referred-common', 'Referred Member', 'referred-common-test', 'hash', 'user')`,
    );
    await database.query("UPDATE users SET referred_by = 'member-common' WHERE id = 'referred-common'");
    await database.query(
        `INSERT INTO invite_rewards (id, required_invites, reward, enabled)
         VALUES ('invite-common', 1, 50, 1)`,
    );
    await database.query(
        `INSERT INTO country_configs (country_code, enabled, settings_json, products_json)
         VALUES ('RW', 1, '{}', '{}')`,
    );
    await database.query(
        `INSERT INTO settings (key, value_json) VALUES ('branding', $1)`,
        [JSON.stringify({ brandName: 'BMG' })],
    );
    const originalQuery = pool.query;
    const originalConnect = pool.connect;
    pool.query = (sql, params) => queryPGlite(database, sql, params);
    pool.connect = async () => ({
        query: (sql, params) => queryPGlite(database, sql, params),
        release() {},
    });
    const app = express();
    app.use(express.json());
    app.use('/api/announcements', announcementsRouter);
    app.use('/api/audit-logs', auditRouter);
    app.use('/api/notifications', notificationsRouter);
    app.use('/api/overview', overviewRouter);
    app.use('/api/presence', presenceRouter);
    app.use('/api/sponsors', sponsorsRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/team', teamRouter);
    app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
    const adminToken = signToken({ id: 'admin-common', role: 'admin', phone_number: 'admin-common-test', auth_version: 0 });
    const memberToken = signToken({ id: 'member-common', role: 'user', phone_number: 'member-common-test', auth_version: 0 });
    const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
    const memberHeaders = { Authorization: `Bearer ${memberToken}`, 'Content-Type': 'application/json' };

    try {
        const brandingResponse = await fetch(`${baseUrl}/settings/branding`);
        assert.equal(brandingResponse.status, 200);
        assert.equal((await brandingResponse.json()).value.brandName, 'BMG');

        const settingsResponse = await fetch(`${baseUrl}/settings`, { headers: memberHeaders });
        assert.equal(settingsResponse.status, 200);
        assert.equal((await settingsResponse.json()).settings.branding.brandName, 'BMG');

        const announcementResponse = await fetch(`${baseUrl}/announcements`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ title: 'Test notice', message: 'Database API is connected.' }),
        });
        assert.equal(announcementResponse.status, 201);
        const { announcement } = await announcementResponse.json();
        const publicAnnouncements = await fetch(`${baseUrl}/announcements`);
        assert.equal((await publicAnnouncements.json()).announcements[0].id, announcement.id);

        const notificationsResponse = await fetch(`${baseUrl}/notifications`, { headers: memberHeaders });
        const notifications = (await notificationsResponse.json()).notifications;
        assert.equal(notificationsResponse.status, 200);
        const announcementNotification = notifications.find((item) => item.relatedId === announcement.id);
        assert.ok(announcementNotification);
        const readResponse = await fetch(`${baseUrl}/notifications/${announcementNotification.id}/read`, {
            method: 'POST',
            headers: memberHeaders,
        });
        assert.equal(readResponse.status, 200);

        const sponsorResponse = await fetch(`${baseUrl}/sponsors`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ name: 'Test sponsor', logoUrl: 'https://example.com/logo.png' }),
        });
        assert.equal(sponsorResponse.status, 201);
        assert.equal((await (await fetch(`${baseUrl}/sponsors`)).json()).sponsors.length, 1);

        const levelResponse = await fetch(`${baseUrl}/team/levels`, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify({ name: 'Starter', requirement: 0, benefit: 'Starter access', displayOrder: 1 }),
        });
        assert.equal(levelResponse.status, 201);
        const levelsResponse = await fetch(`${baseUrl}/team/levels`, { headers: memberHeaders });
        assert.equal((await levelsResponse.json()).levels.length, 1);
        assert.equal((await (await fetch(`${baseUrl}/team/mine`, { headers: memberHeaders })).json()).memberCount, 1);
        const inviteRewardsResponse = await fetch(`${baseUrl}/team/invite-rewards`, { headers: memberHeaders });
        assert.equal((await inviteRewardsResponse.json()).inviteRewards[0].invitedCount, 1);
        const inviteClaimResponse = await fetch(`${baseUrl}/team/invite-rewards/invite-common/claim`, {
            method: 'POST',
            headers: memberHeaders,
        });
        assert.equal(inviteClaimResponse.status, 200);
        assert.equal((await inviteClaimResponse.json()).balance, 50);
        const duplicateInviteClaim = await fetch(`${baseUrl}/team/invite-rewards/invite-common/claim`, {
            method: 'POST',
            headers: memberHeaders,
        });
        assert.equal(duplicateInviteClaim.status, 409);

        const heartbeatResponse = await fetch(`${baseUrl}/presence/heartbeat`, {
            method: 'POST',
            headers: memberHeaders,
            body: JSON.stringify({ page: 'home' }),
        });
        assert.equal(heartbeatResponse.status, 200);
        const presenceResponse = await fetch(`${baseUrl}/presence`, { headers: adminHeaders });
        assert.equal((await presenceResponse.json()).onlineCount, 1);

        const overviewResponse = await fetch(`${baseUrl}/overview`, { headers: adminHeaders });
        assert.equal(overviewResponse.status, 200);
        assert.equal((await overviewResponse.json()).totalUsers, 2);
        const auditResponse = await fetch(`${baseUrl}/audit-logs`, { headers: adminHeaders });
        assert.equal(auditResponse.status, 200);
        assert.ok((await auditResponse.json()).pagination.total >= 3);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        pool.query = originalQuery;
        pool.connect = originalConnect;
        await database.close();
    }
});

test('country configuration validation rejects unsupported or malformed product overrides', () => {
    assert.equal(validateCountryInput({ enabled: true, settings: {}, products: {} }), null);
    assert.match(validateCountryInput({ enabled: true, settings: { unknown: {} }, products: {} }), /Unsupported country setting/);
    assert.match(validateCountryInput({ enabled: true, settings: {}, products: { p1: { arbitrary: 1 } } }), /Unsupported country product field/);
    assert.match(validateCountryInput({ enabled: true, settings: {}, products: { p1: { enabled: 1 } } }), /enabled must be true or false/);
});

test('financial settings validation rejects unsafe deposit and withdrawal limits', () => {
    assert.match(validateSetting('deposit', { enabled: true, mtn: { min: 100, max: 10 } }).error, /deposit settings/);
    assert.match(validateSetting('withdraw', { enabled: true, feePercent: 101 }).error, /fee percentage/);
    assert.match(validateSetting('withdraw', { availability: { enabled: true, days: ['Funday'], openHour: 0, closeHour: 24 } }).error, /availability/);
    assert.match(validateSetting('welcomeBonus', { enabled: true, type: 'percentage', amount: 101, minimumDeposit: 0, expiryDays: 0 }).error, /Welcome Bonus/);
});

test('product validation rejects invalid prices, stock, URLs, and duration settings', () => {
    const product = {
        name: 'Starter plan',
        category: 'Investment',
        price: 100,
        stock: 10,
        totalSlots: 10,
        status: 'active',
        investmentDurationDays: 30,
        dailyIncomeAmount: 10,
        dailyIncomePercent: 10,
        totalIncome: 300,
    };
    assert.equal(validateProduct(product), null);
    assert.match(validateProduct({ ...product, price: 10.5 }), /whole number/);
    assert.match(validateProduct({ ...product, stock: -1 }), /Stock must be a whole number/);
    assert.match(validateProduct({ ...product, productUrl: 'javascript:alert(1)' }), /Product link must use http or https/);
    assert.match(validateProduct({ ...product, investmentDurationDays: -1 }), /Investment duration/);
});

test('Express app imports in PostgreSQL mode without starting a listener or opening SQLite', () => {
    process.env.BMG_DATABASE_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/test';
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    const app = require('../src/index');
    assert.equal(typeof app, 'function');
    assert.equal(app.locals.databaseDriver, 'postgres');
    assert.equal(app.listening, undefined);
    delete process.env.BMG_DATABASE_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
});

test('Express entrypoint only listens on direct execution', () => {
    const entry = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(entry, /if \(require\.main === module\)/);
    assert.match(entry, /module\.exports = app/);
});

test('Vercel serverless entrypoint exports the PostgreSQL Express app', () => {
    process.env.BMG_DATABASE_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgres://test.invalid/bmg';
    process.env.JWT_SECRET = 'test-only-secret-with-at-least-32-characters';
    const handler = require(path.join(__dirname, '..', '..', 'api', '[...path].js'));
    const nestedHandler = require(path.join(__dirname, '..', '..', 'api', '[domain]', '[...path].js'));
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
    const rootPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    const serverPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(typeof handler, 'function');
    assert.equal(nestedHandler, handler);
    assert.equal(handler.locals.databaseDriver, 'postgres');
    assert.equal(vercelConfig.installCommand, 'npm ci');
    assert.deepEqual(rootPackage.dependencies, serverPackage.dependencies);
    assert.equal(vercelConfig.functions['api/[...path].js'].includeFiles, 'server/migrations/**');
    assert.equal(vercelConfig.functions['api/[domain]/[...path].js'].includeFiles, 'server/migrations/**');
    assert.equal(
        fs.readFileSync(path.join(__dirname, '..', '..', 'api', '[domain]', '[...path].js'), 'utf8').trim(),
        "module.exports = require('../../server/src/index');",
    );
    delete process.env.BMG_DATABASE_DRIVER;
    delete process.env.DATABASE_URL;
    delete process.env.JWT_SECRET;
});
