const express = require('express');
const crypto = require('crypto');
const { pool, transaction, uuid, getCountrySetting } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { getCountry } = require('../../utils/countries');

const router = express.Router();

function toPublicTask(row) {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        instructions: row.instructions,
        reward: row.reward,
        enabled: Boolean(row.enabled),
        dailyLimit: row.daily_limit,
        totalLimit: row.total_limit,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
    };
}

function parsePrizes(config) {
    try {
        const prizes = JSON.parse(config?.prizes_json || '[]');
        return Array.isArray(prizes) ? prizes : [];
    } catch (error) {
        console.error('[tasks] Invalid spin prizes_json:', error.message);
        return [];
    }
}

function isScheduledNow(startsAt, endsAt, now = Date.now()) {
    const start = startsAt ? new Date(startsAt).getTime() : null;
    const end = endsAt ? new Date(endsAt).getTime() : null;
    return (!start || now >= start) && (!end || now <= end);
}

async function getJsonSetting(client, key, fallback = {}, countryCode = 'RW') {
    const value = await getCountrySetting(client, countryCode, key);
    return value ? { ...fallback, ...value } : fallback;
}

async function isTaskAvailable(client, slug, enabled = true, countryCode = 'RW') {
    if (slug === 'chakin') {
        const setting = await getJsonSetting(client, 'chakin', { enabled: false, startDate: '', endDate: '' }, countryCode);
        return { available: isChakinAvailable(setting), availabilityReason: isChakinAvailable(setting) ? '' : 'Chakin is not currently available.' };
    }
    if (slug === 'giftcode') {
        const setting = await getJsonSetting(client, 'giftcode', { enabled: false }, countryCode);
        return { available: Boolean(setting.enabled), availabilityReason: setting.enabled ? '' : 'Gift Code is disabled by Admin.' };
    }
    if (slug === 'spinwin') {
        const { rows } = await client.query('SELECT * FROM spin_config WHERE id = 1');
        const config = rows[0];
        const available = Boolean(config?.enabled) && isScheduledNow(config.starts_at, config.ends_at) && parsePrizes(config).some((prize) => prize.enabled !== false);
        return { available, availabilityReason: available ? '' : 'Spin & Win is not currently available.' };
    }
    return enabled
        ? { available: true, availabilityReason: '' }
        : { available: false, availabilityReason: 'This task is disabled by Admin.' };
}

function isChakinAvailable(setting, now = new Date()) {
    if (!setting.enabled) return false;
    const start = setting.startDate ? new Date(`${setting.startDate}T00:00:00`) : null;
    const end = setting.endDate ? new Date(`${setting.endDate}T23:59:59`) : null;
    return (!start || now >= start) && (!end || now <= end);
}

function getCheckInDate(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

async function creditReward(client, userId, amount, source, referenceId, type = 'task_reward', unit = null) {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const user = rows[0];
    if (!user) throw new Error('Reward recipient no longer exists.');
    const currency = unit || getCountry(user.country_code)?.currency || 'RWF';
    const previousBalance = Number(user.balance);
    const newBalance = previousBalance + Number(amount);
    await client.query(
        'UPDATE users SET balance = $1, task_balance = task_balance + $2 WHERE id = $3',
        [newBalance, amount, userId],
    );
    await client.query(
        `INSERT INTO reward_transactions
         (id, user_id, type, amount, unit, source, reference_id, previous_balance, new_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [uuid(), userId, type, amount, currency, source, referenceId, previousBalance, newBalance],
    );
}

router.get('/', requireAuth, async (req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at ASC');
        const rowsBySlug = new Map(rows.map((row) => [row.slug, row]));
        const coreSlugs = ['chakin', 'giftcode', 'spinwin'];
        const coreTasks = await Promise.all(coreSlugs
            .map((slug) => rowsBySlug.get(slug))
            .filter(Boolean)
            .map(async (row) => ({
                ...toPublicTask(row),
                ...await isTaskAvailable(pool, row.slug, true, req.user.country_code),
            })));
        const customTasks = await Promise.all(rows
            .filter((row) => !coreSlugs.includes(row.slug) && row.enabled)
            .map(async (row) => ({
                ...toPublicTask(row),
                ...await isTaskAvailable(pool, row.slug, true),
            })));
        return res.json({ tasks: [...coreTasks, ...customTasks] });
    } catch (error) { return next(error); }
});

router.get('/admin', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at ASC');
        return res.json({ tasks: rows.map(toPublicTask) });
    } catch (error) { return next(error); }
});

router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const { slug, title, description, instructions, reward, dailyLimit, totalLimit } = req.body || {};
        if (!slug || !title) return res.status(400).json({ error: 'Slug and title are required.' });
        const id = uuid();
        const task = await transaction(async (client) => {
            await client.query(
                `INSERT INTO tasks (id, slug, title, description, instructions, reward, daily_limit, total_limit)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [id, slug, title, description || null, instructions || null, Number(reward) || 0, dailyLimit || null, totalLimit || null],
            );
            await logAudit(client, { adminId: req.user.id, action: 'task_created', target: id, newValue: req.body });
            const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ task: toPublicTask(task) });
    } catch (error) { return next(error); }
});

router.patch('/:id', requireAdmin, async (req, res, next) => {
    try {
        const task = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const body = req.body || {};
            await client.query(
                `UPDATE tasks SET title = $1, description = $2, instructions = $3, reward = $4,
                 enabled = $5, daily_limit = $6, total_limit = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8`,
                [
                    body.title ?? existing.title, body.description ?? existing.description,
                    body.instructions ?? existing.instructions, body.reward ?? existing.reward,
                    body.enabled === undefined ? existing.enabled : (body.enabled ? 1 : 0),
                    body.dailyLimit ?? existing.daily_limit, body.totalLimit ?? existing.total_limit, existing.id,
                ],
            );
            await logAudit(client, { adminId: req.user.id, action: 'task_updated', target: existing.id, previousValue: existing, newValue: body });
            const updated = await client.query('SELECT * FROM tasks WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!task) return res.status(404).json({ error: 'Task not found.' });
        return res.json({ task: toPublicTask(task) });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [req.params.id]);
            const task = rows[0];
            if (!task) return false;
            await client.query('DELETE FROM tasks WHERE id = $1', [task.id]);
            await logAudit(client, { adminId: req.user.id, action: 'task_deleted', target: task.id, previousValue: { slug: task.slug } });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Task not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

async function redeemGiftCodeForUser(userId, code, countryCode) {
    const setting = await getJsonSetting(pool, 'giftcode', { enabled: false }, countryCode);
    if (!setting.enabled) return { status: 403, error: 'Gift Code is not currently available.' };
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode) return { status: 400, error: 'A gift code is required.' };
    try {
        return await transaction(async (client) => {
            const { rows: users } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
            if (!users[0]) return { status: 404, error: 'User account not found.' };
            const { rows } = await client.query(
                `SELECT * FROM gift_codes WHERE code = $1 AND enabled = 1
                 AND (country_code IS NULL OR country_code = $2) FOR UPDATE`,
                [normalizedCode, countryCode],
            );
            const giftCode = rows[0];
            if (!giftCode) return { status: 404, error: 'Invalid or expired gift code.' };
            if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) return { status: 410, error: 'This gift code has expired.' };
            const { rows: userUses } = await client.query(
                `SELECT COUNT(*)::int AS count FROM gift_code_redemptions
                 WHERE gift_code_id = $1 AND user_id = $2 AND status = 'completed'`,
                [giftCode.id, userId],
            );
            if (Number(userUses[0].count) >= Number(giftCode.per_user_limit)) {
                return { status: 409, error: 'You have already redeemed this gift code.' };
            }
            if (giftCode.max_uses) {
                const { rows: totalUses } = await client.query(
                    "SELECT COUNT(*)::int AS count FROM gift_code_redemptions WHERE gift_code_id = $1 AND status = 'completed'",
                    [giftCode.id],
                );
                if (Number(totalUses[0].count) >= Number(giftCode.max_uses)) return { status: 409, error: 'This gift code has reached its usage limit.' };
            }
            const redemptionId = uuid();
            await client.query(
                "INSERT INTO gift_code_redemptions (id, gift_code_id, user_id, status) VALUES ($1, $2, $3, 'completed')",
                [redemptionId, giftCode.id, userId],
            );
            await creditReward(client, userId, Number(giftCode.reward), 'Gift Code', redemptionId, 'gift_code');
            return { status: 200, reward: Number(giftCode.reward) };
        });
    } catch (error) {
        console.error('[tasks] Gift Code redemption failed:', error);
        throw error;
    }
}

async function handleChakinCheckIn(req, res, next) {
    try {
        const setting = await getJsonSetting(pool, 'chakin', { enabled: true, reward: 0 }, req.user.country_code);
        if (!isChakinAvailable(setting)) return res.status(403).json({ error: 'Chakin is not currently available.' });
        const now = new Date();
        const today = getCheckInDate(now);
        const result = await transaction(async (client) => {
            const { rows: users } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
            if (!users[0]) return { status: 404, error: 'User account not found.' };
            const { rows: latestRows } = await client.query(
                'SELECT * FROM chakin_checkins WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
                [req.user.id],
            );
            const latest = latestRows[0];
            const cooldownHours = Math.max(0, Number(setting.cooldownHours) || 24);
            if (latest) {
                const elapsedHours = (now.getTime() - new Date(latest.created_at).getTime()) / 3600000;
                if (elapsedHours < cooldownHours) {
                    return { status: 409, error: `You can check in again in ${Math.ceil(cooldownHours - elapsedHours)} hour(s).` };
                }
            }
            const count = await client.query('SELECT COUNT(*)::int AS count FROM chakin_checkins WHERE user_id = $1', [req.user.id]);
            const maxCheckins = Math.max(0, Number(setting.maxCheckins) || 0);
            if (maxCheckins > 0 && Number(count.rows[0].count) >= maxCheckins) {
                return { status: 429, error: 'You have reached the maximum number of check-ins.' };
            }
            const reward = Math.max(0, Number(setting.reward) || 0);
            const referenceId = `chakin-${req.user.id}-${today}`;
            await client.query(
                `INSERT INTO chakin_checkins (id, user_id, check_in_date, reward_amount, reference_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [uuid(), req.user.id, today, reward, referenceId],
            );
            if (reward > 0) await creditReward(client, req.user.id, reward, 'Chakin', referenceId, 'chakin');
            return { ok: true, reward, status: 'submitted for verification' };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (error) { return next(error); }
}

router.post('/chakin/checkin', requireAuth, handleChakinCheckIn);
router.post('/chakin/check-in', requireAuth, handleChakinCheckIn);

router.get('/chakin/status', requireAuth, async (req, res, next) => {
    try {
        const now = new Date();
        const today = getCheckInDate(now);
        const setting = await getJsonSetting(pool, 'chakin', { enabled: true, reward: 0 }, req.user.country_code);
        const [{ rows: todayRows }, { rows: counts }, { rows: latestRows }] = await Promise.all([
            pool.query('SELECT * FROM chakin_checkins WHERE user_id = $1 AND check_in_date = $2 ORDER BY created_at DESC LIMIT 1', [req.user.id, today]),
            pool.query('SELECT COUNT(*)::int AS count FROM chakin_checkins WHERE user_id = $1', [req.user.id]),
            pool.query('SELECT created_at FROM chakin_checkins WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [req.user.id]),
        ]);
        const row = todayRows[0];
        const latest = latestRows[0];
        const cooldownHours = Math.max(0, Number(setting.cooldownHours) || 24);
        return res.json({
            available: isChakinAvailable(setting),
            checkedInToday: Boolean(row),
            totalCheckIns: Number(counts[0].count),
            reward: Math.max(0, Number(setting.reward) || 0),
            checkedInAt: row?.created_at || null,
            cooldownHours,
            cooldownUntil: latest ? new Date(new Date(latest.created_at).getTime() + cooldownHours * 3600000).toISOString() : null,
            maxCheckins: Math.max(0, Number(setting.maxCheckins) || 0),
        });
    } catch (error) { return next(error); }
});

router.get('/chakin/checkins', requireAdmin, async (_req, res, next) => {
    try {
        const today = getCheckInDate();
        const [{ rows: checkins }, { rows: todayRows }, { rows: totalRows }] = await Promise.all([
            pool.query('SELECT c.*, u.full_name, u.phone_number FROM chakin_checkins c JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC LIMIT 200'),
            pool.query('SELECT COUNT(*)::int AS count FROM chakin_checkins WHERE check_in_date = $1', [today]),
            pool.query('SELECT COUNT(*)::int AS count FROM chakin_checkins'),
        ]);
        return res.json({ checkins, todayCount: Number(todayRows[0].count), totalCount: Number(totalRows[0].count) });
    } catch (error) { return next(error); }
});

router.post('/giftcode/redeem', requireAuth, async (req, res, next) => {
    try {
        const result = await redeemGiftCodeForUser(req.user.id, req.body?.code, req.user.country_code);
        if (result.status !== 200) return res.status(result.status).json({ error: result.error });
        return res.json({ ok: true, reward: result.reward });
    } catch (error) { return next(error); }
});

router.post('/gift-codes/redeem', requireAuth, async (req, res, next) => {
    try {
        const result = await redeemGiftCodeForUser(req.user.id, req.body?.code, req.user.country_code);
        if (result.status !== 200) return res.status(result.status).json({ error: result.error });
        return res.json({ ok: true, reward: result.reward });
    } catch (error) { return next(error); }
});

function toPublicGiftCode(row) {
    return {
        id: row.id,
        code: row.code,
        reward: Number(row.reward || 0),
        max_uses: row.max_uses,
        per_user_limit: Number(row.per_user_limit || 1),
        expires_at: row.expires_at,
        enabled: Boolean(row.enabled),
        countryCode: row.country_code || null,
        created_at: row.created_at,
    };
}

router.get('/gift-codes/generate-code', requireAdmin, async (_req, res, next) => {
    try {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const code = `CP${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const { rowCount } = await pool.query('SELECT 1 FROM gift_codes WHERE code = $1', [code]);
            if (!rowCount) return res.json({ code });
        }
        return next(new Error('Could not generate a unique gift code.'));
    } catch (error) { return next(error); }
});

router.get('/gift-codes/all', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM gift_codes ORDER BY created_at DESC');
        return res.json({ giftCodes: rows.map(toPublicGiftCode) });
    } catch (error) { return next(error); }
});

router.post('/gift-codes', requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        const code = String(body.code || `CP${crypto.randomBytes(4).toString('hex').toUpperCase()}`).trim().toUpperCase();
        const reward = Number(body.reward);
        if (!code || !Number.isSafeInteger(reward) || reward <= 0 || reward > 2147483647) {
            return res.status(400).json({ error: 'A valid code and positive whole-number reward are required.' });
        }
        const countryCode = body.countryCode ? String(body.countryCode).toUpperCase() : null;
        if (countryCode && !getCountry(countryCode)) return res.status(400).json({ error: 'Choose a supported country for this gift code.' });
        const maxUses = body.maxUses === null || body.maxUses === undefined ? null : Number(body.maxUses);
        if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1)) return res.status(400).json({ error: 'Maximum uses must be a positive whole number.' });
        const id = uuid();
        const giftCode = await transaction(async (client) => {
            await client.query(
                `INSERT INTO gift_codes (id, code, reward, max_uses, per_user_limit, expires_at, enabled, country_code)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    id, code, reward, maxUses,
                    Math.max(1, Number(body.perUserLimit) || 1),
                    body.expiresAt || null, body.enabled === false ? 0 : 1, countryCode,
                ],
            );
            await logAudit(client, { adminId: req.user.id, action: 'gift_code_created', target: id, newValue: { code, reward, countryCode } });
            const { rows } = await client.query('SELECT * FROM gift_codes WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ giftCode: toPublicGiftCode(giftCode) });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That gift code already exists.' });
        return next(error);
    }
});

router.put('/gift-codes/:id', requireAdmin, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM gift_codes WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            await client.query('UPDATE gift_codes SET enabled = $1 WHERE id = $2', [req.body?.enabled ? 1 : 0, existing.id]);
            await logAudit(client, { adminId: req.user.id, action: 'gift_code_updated', target: existing.id, newValue: req.body });
            const updated = await client.query('SELECT * FROM gift_codes WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!result) return res.status(404).json({ error: 'Gift code not found.' });
        return res.json({ giftCode: toPublicGiftCode(result) });
    } catch (error) { return next(error); }
});

router.delete('/gift-codes/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM gift_codes WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return false;
            await client.query('DELETE FROM gift_codes WHERE id = $1', [existing.id]);
            await logAudit(client, { adminId: req.user.id, action: 'gift_code_deleted', target: existing.id, previousValue: existing });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Gift code not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.get('/gift-codes/redemptions', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT r.*, g.code, u.full_name, u.phone_number
            FROM gift_code_redemptions r JOIN gift_codes g ON g.id = r.gift_code_id
            JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC LIMIT 200
        `);
        return res.json({ redemptions: rows });
    } catch (error) { return next(error); }
});

router.get('/spin/config/admin', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM spin_config WHERE id = 1');
        const config = rows[0];
        if (!config) return res.json({ enabled: false, daily_spins: 0, prizes: [], starts_at: null, ends_at: null });
        const prizes = parsePrizes(config);
        const available = Boolean(config.enabled) && isScheduledNow(config.starts_at, config.ends_at) && prizes.some((prize) => prize.enabled !== false);
        return res.json({ ...config, available, prizes });
    } catch (error) { return next(error); }
});

router.get('/spin/config', requireAuth, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM spin_config WHERE id = 1');
        const config = rows[0];
        if (!config) return res.json({ enabled: false, dailySpins: 0, prizes: [] });
        const available = Boolean(config.enabled) && isScheduledNow(config.starts_at, config.ends_at);
        const prizes = parsePrizes(config).filter((prize) => prize.enabled !== false);
        return res.json({ enabled: available && prizes.length > 0, dailySpins: config.daily_spins, prizes });
    } catch (error) { return next(error); }
});

router.put('/spin/config', requireAdmin, async (req, res, next) => {
    try {
        const body = req.body || {};
        if (body.startsAt && body.endsAt && new Date(body.endsAt).getTime() <= new Date(body.startsAt).getTime()) {
            return res.status(400).json({ error: 'Spin end time must be after the start time.' });
        }
        const prizes = Array.isArray(body.prizes) ? body.prizes.map((prize) => ({
            label: String(prize.label || '').trim(),
            weight: Math.max(1, Number(prize.weight) || 1),
            points: Math.max(0, Number(prize.points ?? prize.amount) || 0),
            enabled: prize.enabled !== false,
        })).filter((prize) => prize.label) : [];
        if (!prizes.length) return res.status(400).json({ error: 'At least one wheel reward is required.' });
        await transaction(async (client) => {
            await client.query(
                `INSERT INTO spin_config (id, enabled, daily_spins, starts_at, ends_at, prizes_json)
                 VALUES (1, $1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, daily_spins = EXCLUDED.daily_spins,
                    starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, prizes_json = EXCLUDED.prizes_json`,
                [body.enabled ? 1 : 0, Math.max(1, Number(body.dailySpins) || 1), body.startsAt || null, body.endsAt || null, JSON.stringify(prizes)],
            );
            await logAudit(client, { adminId: req.user.id, action: 'spin_config_updated', target: 'spin_config', newValue: { ...body, prizes } });
        });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.get('/spin/history', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.*, u.full_name, u.phone_number
            FROM spin_results s JOIN users u ON u.id = s.user_id
            ORDER BY s.created_at DESC LIMIT 100
        `);
        return res.json({ history: rows });
    } catch (error) { return next(error); }
});

router.post('/spin/play', requireAuth, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows: configs } = await client.query('SELECT * FROM spin_config WHERE id = 1 FOR UPDATE');
            const config = configs[0];
            if (!config || !config.enabled) return { status: 403, error: 'Spin & Win is not currently available.' };
            const now = Date.now();
            if ((config.starts_at && now < new Date(config.starts_at).getTime()) || (config.ends_at && now > new Date(config.ends_at).getTime())) {
                return { status: 403, error: 'Spin & Win is outside its configured schedule.' };
            }
            const { rows: users } = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
            if (!users[0]) return { status: 401, error: 'Account no longer exists.' };
            const today = getCheckInDate();
            const { rows: counts } = await client.query(
                'SELECT COUNT(*)::int AS count FROM spin_results WHERE user_id = $1 AND created_at::date = $2::date',
                [req.user.id, today],
            );
            if (Number(counts[0].count) >= Number(config.daily_spins)) return { status: 429, error: 'You have used all your spins for today.' };
            const prizes = parsePrizes(config).filter((prize) => prize.enabled !== false);
            if (!prizes.length) return { status: 503, error: 'No active Spin & Win rewards are configured.' };
            const totalWeight = prizes.reduce((sum, prize) => sum + Number(prize.weight || 0), 0);
            let roll = Math.random() * totalWeight;
            let selectedIndex = prizes.length - 1;
            for (let index = 0; index < prizes.length; index += 1) {
                if (roll < prizes[index].weight) { selectedIndex = index; break; }
                roll -= prizes[index].weight;
            }
            const selected = prizes[selectedIndex];
            const points = Number(selected.points ?? selected.amount ?? 0);
            const resultId = uuid();
            await client.query(
                'INSERT INTO spin_results (id, user_id, prize_label, amount, reference_id) VALUES ($1, $2, $3, $4, $5)',
                [resultId, req.user.id, selected.label, points, resultId],
            );
            if (points > 0) await creditReward(client, req.user.id, points, 'Spin & Win', resultId, 'spin_win', 'POINTS');
            return { prizeIndex: selectedIndex, prizeLabel: selected.label, points, prize: { ...selected, points } };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.json(result);
    } catch (error) { return next(error); }
});

module.exports = { router, parsePrizes, isScheduledNow, isChakinAvailable, getCheckInDate, creditReward };
