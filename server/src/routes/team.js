// Team levels (Bronze/Silver/Gold-style tiers) and a user's own team overview.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { getCountrySetting } = require('../utils/countries');

const router = express.Router();

function toPublicLevel(row) {
    return {
        id: row.id,
        name: row.name,
        requirement: row.requirement,
        benefit: row.benefit,
        displayOrder: row.display_order,
        status: row.status,
    };
}

router.get('/levels', requireAuth, (req, res) => {
    const rows = db.prepare("SELECT * FROM team_levels WHERE status = 'active' ORDER BY display_order ASC").all();
    res.json({ levels: rows.map(toPublicLevel) });
});

router.get('/levels/admin', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT * FROM team_levels ORDER BY display_order ASC').all();
    res.json({ levels: rows.map(toPublicLevel) });
});

router.post('/levels', requireAdmin, (req, res) => {
    const { name, requirement, benefit, displayOrder } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Level name is required.' });

    const id = uuid();
    db.prepare('INSERT INTO team_levels (id, name, requirement, benefit, display_order) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, Number(requirement) || 0, benefit || null, Number(displayOrder) || 0);
    logAudit({ adminId: req.user.id, action: 'team_level_created', target: id, newValue: req.body });
    res.status(201).json({ level: toPublicLevel(db.prepare('SELECT * FROM team_levels WHERE id = ?').get(id)) });
});

router.patch('/levels/:id', requireAdmin, (req, res) => {
    const level = db.prepare('SELECT * FROM team_levels WHERE id = ?').get(req.params.id);
    if (!level) return res.status(404).json({ error: 'Team level not found.' });

    const body = req.body || {};
    db.prepare("UPDATE team_levels SET name = ?, requirement = ?, benefit = ?, display_order = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(
        body.name ?? level.name,
        body.requirement ?? level.requirement,
        body.benefit ?? level.benefit,
        body.displayOrder ?? level.display_order,
        body.status ?? level.status,
        level.id,
    );
    logAudit({ adminId: req.user.id, action: 'team_level_updated', target: level.id, previousValue: level, newValue: body });
    res.json({ level: toPublicLevel(db.prepare('SELECT * FROM team_levels WHERE id = ?').get(level.id)) });
});

router.delete('/levels/:id', requireAdmin, (req, res) => {
    const level = db.prepare('SELECT * FROM team_levels WHERE id = ?').get(req.params.id);
    if (!level) return res.status(404).json({ error: 'Team level not found.' });

    db.prepare('DELETE FROM team_levels WHERE id = ?').run(level.id);
    logAudit({ adminId: req.user.id, action: 'team_level_deleted', target: level.id, previousValue: { name: level.name } });
    res.json({ ok: true });
});

router.get('/mine', requireAuth, (req, res) => {
    const members = db.prepare("SELECT id, full_name, phone_number, created_at FROM users WHERE referred_by = ? AND role = 'user'").all(req.user.id);
    const level = req.user.team_level_id ? db.prepare('SELECT * FROM team_levels WHERE id = ?').get(req.user.team_level_id) : null;
    res.json({
        memberCount: members.length,
        members: members.map((m) => ({ id: m.id, fullName: m.full_name, phoneNumber: m.phone_number, joinedAt: m.created_at })),
        level: level ? toPublicLevel(level) : null,
    });
});

router.get('/commissions', requireAuth, (req, res) => {
    const configured = getCountrySetting(db, req.user.country_code, 'commissions');
    const rows = Array.isArray(configured)
        ? configured
        : db.prepare('SELECT level, percent FROM commissions ORDER BY level ASC').all();
    res.json({ commissions: rows });
});

router.get('/invite-rewards', requireAuth, (req, res) => {
    const countryRewards = getCountrySetting(db, req.user.country_code, 'inviteRewards');
    const baseRows = Array.isArray(countryRewards)
        ? countryRewards
        : db.prepare('SELECT id, required_invites AS requiredInvites, reward, enabled FROM invite_rewards').all();
    const rows = baseRows.filter((item) => item.enabled !== false && item.enabled !== 0).map((item) => {
        const claimed = db.prepare(`
            SELECT 1 FROM reward_transactions
            WHERE user_id = ? AND type = 'invite_reward' AND reference_id = ? LIMIT 1
        `).get(req.user.id, item.id);
        const invited = db.prepare("SELECT COUNT(DISTINCT id) AS count FROM users WHERE referred_by = ? AND role = 'user'").get(req.user.id);
        return {
            id: item.id,
            required_invites: item.requiredInvites ?? item.required_invites,
            reward: item.reward,
            invited_count: invited.count,
            claimed: Boolean(claimed),
        };
    });
    res.json({
        inviteRewards: rows.map((row) => ({
            id: row.id,
            requiredInvites: Number(row.required_invites),
            reward: Number(row.reward),
            invitedCount: Number(row.invited_count),
            claimed: !!row.claimed,
        })),
    });
});

router.post('/invite-rewards/:id/claim', requireAuth, (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    try {
        const countryRewards = getCountrySetting(db, req.user.country_code, 'inviteRewards');
        const configuredReward = Array.isArray(countryRewards)
            ? countryRewards.find((item) => String(item.id) === String(req.params.id) && item.enabled !== false)
            : null;
        const legacyReward = Array.isArray(countryRewards)
            ? null
            : db.prepare('SELECT * FROM invite_rewards WHERE id = ? AND enabled = 1').get(req.params.id);
        const reward = configuredReward
            ? { ...configuredReward, required_invites: configuredReward.requiredInvites ?? configuredReward.required_invites }
            : legacyReward;
        if (!reward) {
            db.exec('ROLLBACK');
            return res.status(404).json({ error: 'Invite reward not found or disabled.' });
        }
        const existingClaim = db.prepare("SELECT id FROM reward_transactions WHERE user_id = ? AND type = 'invite_reward' AND reference_id = ?").get(req.user.id, reward.id);
        if (existingClaim) {
            db.exec('ROLLBACK');
            return res.status(409).json({ error: 'This invite reward has already been claimed.' });
        }
        const invitedCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE referred_by = ? AND role = 'user'").get(req.user.id).count;
        if (Number(invitedCount) < Number(reward.required_invites)) {
            db.exec('ROLLBACK');
            return res.status(400).json({
                error: `Invite at least ${Number(reward.required_invites)} friends before claiming this reward.`,
                invitedCount: Number(invitedCount),
                requiredInvites: Number(reward.required_invites),
            });
        }
        const user = db.prepare('SELECT balance, commission_balance FROM users WHERE id = ?').get(req.user.id);
        if (!user) {
            db.exec('ROLLBACK');
            return res.status(404).json({ error: 'User account not found.' });
        }
        const amount = Math.max(0, Math.round(Number(reward.reward)));
        const newBalance = Number(user.balance) + amount;
        db.prepare('UPDATE users SET balance = ?, commission_balance = commission_balance + ? WHERE id = ?')
            .run(newBalance, amount, req.user.id);
        db.prepare(`
            INSERT INTO reward_transactions (id, user_id, type, amount, source, reference_id, previous_balance, new_balance, status)
            VALUES (?, ?, 'invite_reward', ?, ?, ?, ?, ?, 'completed')
        `).run(uuid(), req.user.id, amount, `Invite Reward: ${reward.required_invites} registered referrals`, reward.id, user.balance, newBalance);
        db.exec('COMMIT');
        res.json({ ok: true, reward: amount, balance: newBalance });
    } catch (error) {
        db.exec('ROLLBACK');
        console.error('[team] Could not claim invite reward:', error);
        res.status(500).json({ error: 'Unable to claim invite reward.' });
    }
});

router.get('/my-team', requireAuth, (req, res) => {
    const members = db.prepare("SELECT id, full_name, phone_number, created_at FROM users WHERE referred_by = ? AND role = 'user' ORDER BY created_at DESC").all(req.user.id);
    const commissionLevels = db.prepare('SELECT level FROM commissions ORDER BY level ASC').all();
    const maximumCommissionLevel = Math.min(10, Math.max(0, ...commissionLevels.map((commission) => Number(commission.level))));
    const levelMemberRows = db.prepare(`
        WITH RECURSIVE referral_tree(user_id, depth, path) AS (
            SELECT id, 1, ',' || id || ','
            FROM users
            WHERE referred_by = ? AND role = 'user'
            UNION ALL
            SELECT child.id, referral_tree.depth + 1, referral_tree.path || child.id || ','
            FROM users child
            JOIN referral_tree ON child.referred_by = referral_tree.user_id
            WHERE child.role = 'user'
              AND referral_tree.depth < ?
              AND instr(referral_tree.path, ',' || child.id || ',') = 0
        )
        SELECT depth, COUNT(*) AS member_count
        FROM referral_tree
        WHERE depth <= ?
        GROUP BY depth
    `).all(req.user.id, maximumCommissionLevel, maximumCommissionLevel);
    const referralCountsByLevel = Object.fromEntries(commissionLevels.map(({ level }) => [Number(level), 0]));
    levelMemberRows.forEach(({ depth, member_count }) => {
        if (Object.hasOwn(referralCountsByLevel, Number(depth))) referralCountsByLevel[Number(depth)] = Number(member_count);
    });
    const totalCommissionEarnings = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM reward_transactions
        WHERE user_id = ? AND type = 'commission' AND status = 'completed'
    `).get(req.user.id).total;
    const qualifiedMemberCount = db.prepare(`
        SELECT COUNT(DISTINCT u.id) AS count
        FROM users u
        JOIN product_purchases p ON p.user_id = u.id AND p.status = 'completed'
        WHERE u.referred_by = ? AND u.role = 'user'
    `).get(req.user.id).count;
    const memberCount = members.length;
    const levels = db.prepare("SELECT * FROM team_levels WHERE status = 'active' ORDER BY requirement ASC").all();
    let currentLevel = null;
    let nextLevel = null;
    for (const level of levels) {
        if (memberCount >= level.requirement) currentLevel = level;
        else { nextLevel = level; break; }
    }
    res.json({
        referralCode: req.user.referral_code,
        memberCount,
        totalCommissionEarnings: Number(totalCommissionEarnings),
        referralCountsByLevel,
        qualifiedMemberCount: Number(qualifiedMemberCount),
        currentLevel: currentLevel ? toPublicLevel(currentLevel) : null,
        nextLevel: nextLevel ? toPublicLevel(nextLevel) : null,
        members,
    });
});

module.exports = { router };
