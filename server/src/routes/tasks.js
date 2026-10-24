// Daily engagement tasks: Chakin check-in, Gift Code redemption, Spin & Win, plus generic
// custom tasks that admins can configure. Rewards are always credited via reward_transactions
// with a unique reference so a user can never double-claim the same reward.
const express = require('express');
const crypto = require('crypto');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { getCountry, getCountrySetting } = require('../utils/countries');

const router = express.Router();

function creditReward(userId, amount, source, referenceId, type = 'task_reward', unit = null) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    unit = unit || getCountry(user.country_code)?.currency || 'RWF';
    const newBalance = user.balance + amount;
    db.prepare('UPDATE users SET balance = ?, task_balance = task_balance + ? WHERE id = ?').run(newBalance, amount, userId);
    db.prepare(
        'INSERT INTO reward_transactions (id, user_id, type, amount, unit, source, reference_id, previous_balance, new_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(uuid(), userId, type, amount, unit, source, referenceId, user.balance, newBalance);
}

function toPublicTask(row) {
    return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        description: row.description,
        instructions: row.instructions,
        reward: row.reward,
        enabled: !!row.enabled,
        dailyLimit: row.daily_limit,
        totalLimit: row.total_limit,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
    };
}

function getJsonSetting(key, fallback = {}, countryCode = 'RW') {
    const value = getCountrySetting(db, countryCode, key);
    if (!value) return fallback;
    return { ...fallback, ...value };
}

function getSpinPrizes(config) {
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

function getUserTaskAvailability(slug, enabled = true, countryCode = 'RW') {
    if (slug === 'chakin') {
        const setting = getJsonSetting('chakin', { enabled: false, startDate: '', endDate: '' }, countryCode);
        const available = isChakinAvailable(setting);
        return { available, availabilityReason: available ? '' : 'Chakin is not currently available.' };
    }
    if (slug === 'giftcode') {
        const setting = getJsonSetting('giftcode', { enabled: false }, countryCode);
        const available = !!setting.enabled;
        return { available, availabilityReason: available ? '' : 'Gift Code is disabled by Admin.' };
    }
    if (slug === 'spinwin') {
        const config = db.prepare('SELECT * FROM spin_config WHERE id = 1').get();
        const available = !!config?.enabled && isScheduledNow(config.starts_at, config.ends_at) && getSpinPrizes(config).some((prize) => prize.enabled !== false);
        return { available, availabilityReason: available ? '' : 'Spin & Win is not currently available.' };
    }
    return enabled
        ? { available: true, availabilityReason: '' }
        : { available: false, availabilityReason: 'This task is disabled by Admin.' };
}

router.get('/', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all();
    const rowsBySlug = new Map(rows.map((row) => [row.slug, row]));
    const coreSlugs = ['chakin', 'giftcode', 'spinwin'];
    const coreTasks = coreSlugs
        .map((slug) => rowsBySlug.get(slug))
        .filter(Boolean)
        .map((row) => ({ ...toPublicTask(row), ...getUserTaskAvailability(row.slug, true, req.user.country_code) }));
    const customTasks = rows
        .filter((row) => !coreSlugs.includes(row.slug) && row.enabled)
        .map((row) => ({ ...toPublicTask(row), ...getUserTaskAvailability(row.slug, true) }));
    res.json({ tasks: [...coreTasks, ...customTasks] });
});

router.get('/admin', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all();
    res.json({ tasks: rows.map(toPublicTask) });
});

router.post('/', requireAdmin, (req, res) => {
    const { slug, title, description, instructions, reward, dailyLimit, totalLimit } = req.body || {};
    if (!slug || !title) return res.status(400).json({ error: 'Slug and title are required.' });

    const id = uuid();
    db.prepare(
        'INSERT INTO tasks (id, slug, title, description, instructions, reward, daily_limit, total_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, slug, title, description || null, instructions || null, Number(reward) || 0, dailyLimit || null, totalLimit || null);

    logAudit({ adminId: req.user.id, action: 'task_created', target: id, newValue: req.body });
    res.status(201).json({ task: toPublicTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)) });
});

router.patch('/:id', requireAdmin, (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });

    const body = req.body || {};
    db.prepare("UPDATE tasks SET title = ?, description = ?, instructions = ?, reward = ?, enabled = ?, daily_limit = ?, total_limit = ?, updated_at = datetime('now') WHERE id = ?").run(
        body.title ?? task.title,
        body.description ?? task.description,
        body.instructions ?? task.instructions,
        body.reward ?? task.reward,
        body.enabled === undefined ? task.enabled : (body.enabled ? 1 : 0),
        body.dailyLimit ?? task.daily_limit,
        body.totalLimit ?? task.total_limit,
        task.id,
    );
    logAudit({ adminId: req.user.id, action: 'task_updated', target: task.id, previousValue: task, newValue: body });
    res.json({ task: toPublicTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)) });
});

router.delete('/:id', requireAdmin, (req, res) => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    logAudit({ adminId: req.user.id, action: 'task_deleted', target: task.id, previousValue: { slug: task.slug } });
    res.json({ ok: true });
});

function getChakinSetting(countryCode = 'RW') {
    const fallback = { enabled: true, reward: 0 };
    return getJsonSetting('chakin', fallback, countryCode);
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

function redeemGiftCodeForUser(userId, code, countryCode) {
    const setting = getJsonSetting('giftcode', { enabled: false }, countryCode);
    if (!setting.enabled) return { status: 403, error: 'Gift Code is not currently available.' };
    const normalizedCode = String(code || '').trim().toUpperCase();
    if (!normalizedCode) return { status: 400, error: 'A gift code is required.' };

    db.exec('BEGIN IMMEDIATE');
    try {
        const giftCode = db.prepare("SELECT * FROM gift_codes WHERE code = ? AND enabled = 1 AND (country_code IS NULL OR country_code = ?)").get(normalizedCode, countryCode);
        if (!giftCode) { db.exec('ROLLBACK'); return { status: 404, error: 'Invalid or expired gift code.' }; }
        if (giftCode.expires_at && new Date(giftCode.expires_at) < new Date()) { db.exec('ROLLBACK'); return { status: 410, error: 'This gift code has expired.' }; }

        const usedByUser = db.prepare("SELECT COUNT(*) AS c FROM gift_code_redemptions WHERE gift_code_id = ? AND user_id = ? AND status = 'completed'").get(giftCode.id, userId).c;
        if (usedByUser >= giftCode.per_user_limit) { db.exec('ROLLBACK'); return { status: 409, error: 'You have already redeemed this gift code.' }; }

        if (giftCode.max_uses) {
            const totalUses = db.prepare("SELECT COUNT(*) AS c FROM gift_code_redemptions WHERE gift_code_id = ? AND status = 'completed'").get(giftCode.id).c;
            if (totalUses >= giftCode.max_uses) { db.exec('ROLLBACK'); return { status: 409, error: 'This gift code has reached its usage limit.' }; }
        }

        const redemptionId = uuid();
        db.prepare("INSERT INTO gift_code_redemptions (id, gift_code_id, user_id, status) VALUES (?, ?, ?, 'completed')").run(redemptionId, giftCode.id, userId);
        creditReward(userId, giftCode.reward, 'Gift Code', redemptionId, 'gift_code');
        db.exec('COMMIT');
        return { status: 200, reward: giftCode.reward };
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch (rollbackError) { /* transaction already closed */ }
        console.error('[tasks] Gift Code redemption failed:', error);
        return { status: 500, error: 'Gift Code redemption failed because of a server/database error.' };
    }
}

function handleChakinCheckIn(req, res) {
    const setting = getChakinSetting(req.user.country_code);
    if (!isChakinAvailable(setting)) return res.status(403).json({ error: 'Chakin is not currently available.' });

    const now = new Date();
    const today = getCheckInDate(now);
    const latest = db.prepare('SELECT * FROM chakin_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
    const cooldownHours = Math.max(0, Number(setting.cooldownHours) || 24);
    if (latest) {
        const elapsedHours = (now.getTime() - new Date(latest.created_at).getTime()) / 3600000;
        if (elapsedHours < cooldownHours) return res.status(409).json({ error: `You can check in again in ${Math.ceil(cooldownHours - elapsedHours)} hour(s).` });
    }
    const maxCheckins = Math.max(0, Number(setting.maxCheckins) || 0);
    if (maxCheckins > 0 && Number(db.prepare('SELECT COUNT(*) AS count FROM chakin_checkins WHERE user_id = ?').get(req.user.id).count) >= maxCheckins) {
        return res.status(429).json({ error: 'You have reached the maximum number of check-ins.' });
    }

    const reward = Math.max(0, Number(setting.reward) || 0);
    const referenceId = `chakin-${req.user.id}-${today}`;

    db.prepare('INSERT INTO chakin_checkins (id, user_id, check_in_date, reward_amount, reference_id) VALUES (?, ?, ?, ?, ?)')
        .run(uuid(), req.user.id, today, reward, referenceId);
    if (reward > 0) creditReward(req.user.id, reward, 'Chakin', referenceId, 'chakin');

    res.json({ ok: true, reward, status: 'submitted for verification' });
}

// -- Chakin (daily check-in) --
router.post('/chakin/checkin', requireAuth, handleChakinCheckIn);
router.post('/chakin/check-in', requireAuth, handleChakinCheckIn);

router.get('/chakin/status', requireAuth, (req, res) => {
    const now = new Date();
    const today = getCheckInDate(now);
    const setting = getChakinSetting(req.user.country_code);
    const row = db.prepare('SELECT * FROM chakin_checkins WHERE user_id = ? AND check_in_date = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id, today);
    const checkedInToday = !!row;
    const streak = db.prepare('SELECT COUNT(*) AS c FROM chakin_checkins WHERE user_id = ?').get(req.user.id).c;
    const reward = Math.max(0, Number(setting.reward) || 0);
    const latest = db.prepare('SELECT created_at FROM chakin_checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.user.id);
    const cooldownHours = Math.max(0, Number(setting.cooldownHours) || 24);
    res.json({
        available: isChakinAvailable(setting),
        checkedInToday,
        totalCheckIns: streak,
        reward,
        checkedInAt: row?.created_at || null,
        cooldownHours,
        cooldownUntil: latest ? new Date(new Date(latest.created_at).getTime() + cooldownHours * 3600000).toISOString() : null,
        maxCheckins: Math.max(0, Number(setting.maxCheckins) || 0),
    });
});

router.get('/chakin/checkins', requireAdmin, (req, res) => {
    const today = getCheckInDate();
    const checkins = db.prepare(`SELECT c.*, u.full_name, u.phone_number FROM chakin_checkins c JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC LIMIT 200`).all();
    const todayCount = db.prepare('SELECT COUNT(*) AS count FROM chakin_checkins WHERE check_in_date = ?').get(today).count;
    const totalCount = db.prepare('SELECT COUNT(*) AS count FROM chakin_checkins').get().count;
    res.json({ checkins, todayCount, totalCount });
});

// -- Gift codes --
router.post('/giftcode/redeem', requireAuth, (req, res) => {
    const result = redeemGiftCodeForUser(req.user.id, req.body?.code, req.user.country_code);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, reward: result.reward });
});

router.post('/gift-codes/redeem', requireAuth, (req, res) => {
    const result = redeemGiftCodeForUser(req.user.id, req.body?.code, req.user.country_code);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, reward: result.reward });
});

// Admin Gift Code management. These routes mirror the admin.js contract while
// keeping redemption itself restricted to authenticated users above.
function toPublicGiftCode(row) {
    return {
        id: row.id,
        code: row.code,
        reward: Number(row.reward || 0),
        max_uses: row.max_uses,
        per_user_limit: Number(row.per_user_limit || 1),
        expires_at: row.expires_at,
        enabled: !!row.enabled,
        countryCode: row.country_code || null,
        created_at: row.created_at,
    };
}

router.get('/gift-codes/generate-code', requireAdmin, (req, res) => {
    let code;
    do {
        code = `CP${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    } while (db.prepare('SELECT 1 FROM gift_codes WHERE code = ?').get(code));
    res.json({ code });
});

router.get('/gift-codes/all', requireAdmin, (req, res) => {
    const giftCodes = db.prepare('SELECT * FROM gift_codes ORDER BY created_at DESC').all().map(toPublicGiftCode);
    res.json({ giftCodes });
});

router.post('/gift-codes', requireAdmin, (req, res) => {
    const body = req.body || {};
    const code = String(body.code || `CP${crypto.randomBytes(4).toString('hex').toUpperCase()}`).trim().toUpperCase();
    const reward = Number(body.reward);
    if (!code || !Number.isFinite(reward) || reward <= 0) return res.status(400).json({ error: 'A valid code and positive reward are required.' });
    if (db.prepare('SELECT 1 FROM gift_codes WHERE code = ?').get(code)) return res.status(409).json({ error: 'That gift code already exists.' });
    const countryCode = body.countryCode ? String(body.countryCode).toUpperCase() : null;
    if (countryCode && !getCountry(countryCode)) return res.status(400).json({ error: 'Choose a supported country for this gift code.' });
    const id = uuid();
    db.prepare('INSERT INTO gift_codes (id, code, reward, max_uses, per_user_limit, expires_at, enabled, country_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, code, reward, body.maxUses === null || body.maxUses === undefined ? null : Number(body.maxUses), Math.max(1, Number(body.perUserLimit) || 1), body.expiresAt || null, body.enabled === false ? 0 : 1, countryCode);
    logAudit({ adminId: req.user.id, action: 'gift_code_created', target: id, newValue: { code, reward, countryCode } });
    res.status(201).json({ giftCode: toPublicGiftCode(db.prepare('SELECT * FROM gift_codes WHERE id = ?').get(id)) });
});

router.put('/gift-codes/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM gift_codes WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Gift code not found.' });
    db.prepare('UPDATE gift_codes SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, existing.id);
    logAudit({ adminId: req.user.id, action: 'gift_code_updated', target: existing.id, newValue: req.body });
    res.json({ giftCode: toPublicGiftCode(db.prepare('SELECT * FROM gift_codes WHERE id = ?').get(existing.id)) });
});

router.delete('/gift-codes/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM gift_codes WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Gift code not found.' });
    db.prepare('DELETE FROM gift_codes WHERE id = ?').run(existing.id);
    logAudit({ adminId: req.user.id, action: 'gift_code_deleted', target: existing.id, previousValue: existing });
    res.json({ ok: true });
});

router.get('/gift-codes/redemptions', requireAdmin, (req, res) => {
    const redemptions = db.prepare(`
        SELECT r.*, g.code, u.full_name, u.phone_number
        FROM gift_code_redemptions r
        JOIN gift_codes g ON g.id = r.gift_code_id
        JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC LIMIT 200
    `).all();
    res.json({ redemptions });
});

// -- Spin & Win --
router.get('/spin/config/admin', requireAdmin, (req, res) => {
    const config = db.prepare('SELECT * FROM spin_config WHERE id = 1').get();
    if (!config) return res.json({ enabled: false, daily_spins: 0, prizes: [], starts_at: null, ends_at: null });
    const prizes = getSpinPrizes(config);
    const available = !!config.enabled && isScheduledNow(config.starts_at, config.ends_at) && prizes.some((prize) => prize.enabled !== false);
    res.json({ ...config, available, prizes });
});

router.get('/spin/config', requireAuth, (req, res) => {
    const config = db.prepare('SELECT * FROM spin_config WHERE id = 1').get();
    if (!config) return res.json({ enabled: false, dailySpins: 0, prizes: [] });
    const now = Date.now();
    const startsAt = config.starts_at ? new Date(config.starts_at).getTime() : null;
    const endsAt = config.ends_at ? new Date(config.ends_at).getTime() : null;
    const available = !!config.enabled && (!startsAt || now >= startsAt) && (!endsAt || now <= endsAt);
    const prizes = getSpinPrizes(config).filter((prize) => prize.enabled !== false);
    res.json({ enabled: available && prizes.length > 0, dailySpins: config.daily_spins, prizes });
});

router.put('/spin/config', requireAdmin, (req, res) => {
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
    db.prepare('UPDATE spin_config SET enabled = ?, daily_spins = ?, starts_at = ?, ends_at = ?, prizes_json = ? WHERE id = 1')
        .run(body.enabled ? 1 : 0, Math.max(1, Number(body.dailySpins) || 1), body.startsAt || null, body.endsAt || null, JSON.stringify(prizes));
    logAudit({ adminId: req.user.id, action: 'spin_config_updated', target: 'spin_config', newValue: { ...body, prizes } });
    res.json({ ok: true });
});

router.get('/spin/history', requireAdmin, (req, res) => {
    const history = db.prepare(`
        SELECT s.*, u.full_name, u.phone_number
        FROM spin_results s JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC LIMIT 100
    `).all();
    res.json({ history });
});

router.post('/spin/play', requireAuth, (req, res) => {
    const config = db.prepare('SELECT * FROM spin_config WHERE id = 1').get();
    if (!config || !config.enabled) return res.status(403).json({ error: 'Spin & Win is not currently available.' });
    const now = Date.now();
    if ((config.starts_at && now < new Date(config.starts_at).getTime()) || (config.ends_at && now > new Date(config.ends_at).getTime())) {
        return res.status(403).json({ error: 'Spin & Win is outside its configured schedule.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const spinsToday = db.prepare("SELECT COUNT(*) AS c FROM spin_results WHERE user_id = ? AND date(created_at) = ?").get(req.user.id, today).c;
    if (spinsToday >= config.daily_spins) return res.status(429).json({ error: 'You have used all your spins for today.' });

    const prizes = getSpinPrizes(config).filter((prize) => prize.enabled !== false);
    if (!prizes.length) return res.status(503).json({ error: 'No active Spin & Win rewards are configured.' });
    const totalWeight = prizes.reduce((sum, p) => sum + (p.weight || 0), 0);
    let roll = Math.random() * totalWeight;
    let selectedIndex = prizes.length - 1;
    for (let index = 0; index < prizes.length; index += 1) {
        if (roll < prizes[index].weight) { selectedIndex = index; break; }
        roll -= prizes[index].weight;
    }
    const selected = prizes[selectedIndex];
    const points = Number(selected.points ?? selected.amount ?? 0);

    const resultId = uuid();
    db.prepare('INSERT INTO spin_results (id, user_id, prize_label, amount, reference_id) VALUES (?, ?, ?, ?, ?)')
        .run(resultId, req.user.id, selected.label, points, resultId);
    if (points > 0) creditReward(req.user.id, points, 'Spin & Win', resultId, 'spin_win', 'POINTS');

    res.json({ prizeIndex: selectedIndex, prizeLabel: selected.label, points, prize: { ...selected, points } });
});

module.exports = { router };
