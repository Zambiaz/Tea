const express = require('express');
const { pool, transaction, uuid, getCountrySetting } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');

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

router.get('/levels', requireAuth, async (_req, res, next) => {
    try {
        const { rows } = await pool.query("SELECT * FROM team_levels WHERE status = 'active' ORDER BY display_order ASC");
        return res.json({ levels: rows.map(toPublicLevel) });
    } catch (error) { return next(error); }
});

router.get('/levels/admin', requireAdmin, async (_req, res, next) => {
    try {
        const { rows } = await pool.query('SELECT * FROM team_levels ORDER BY display_order ASC');
        return res.json({ levels: rows.map(toPublicLevel) });
    } catch (error) { return next(error); }
});

router.post('/levels', requireAdmin, async (req, res, next) => {
    try {
        const { name, requirement, benefit, displayOrder } = req.body || {};
        if (!name) return res.status(400).json({ error: 'Level name is required.' });
        const id = uuid();
        const level = await transaction(async (client) => {
            await client.query(
                'INSERT INTO team_levels (id, name, requirement, benefit, display_order) VALUES ($1, $2, $3, $4, $5)',
                [id, name, Number(requirement) || 0, benefit || null, Number(displayOrder) || 0],
            );
            await logAudit(client, { adminId: req.user.id, action: 'team_level_created', target: id, newValue: req.body });
            const { rows } = await client.query('SELECT * FROM team_levels WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ level: toPublicLevel(level) });
    } catch (error) { return next(error); }
});

router.patch('/levels/:id', requireAdmin, async (req, res, next) => {
    try {
        const level = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM team_levels WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const body = req.body || {};
            await client.query(
                `UPDATE team_levels SET name = $1, requirement = $2, benefit = $3,
                 display_order = $4, status = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6`,
                [
                    body.name ?? existing.name,
                    body.requirement ?? existing.requirement,
                    body.benefit ?? existing.benefit,
                    body.displayOrder ?? existing.display_order,
                    body.status ?? existing.status,
                    existing.id,
                ],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'team_level_updated',
                target: existing.id,
                previousValue: existing,
                newValue: body,
            });
            const updated = await client.query('SELECT * FROM team_levels WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!level) return res.status(404).json({ error: 'Team level not found.' });
        return res.json({ level: toPublicLevel(level) });
    } catch (error) { return next(error); }
});

router.delete('/levels/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM team_levels WHERE id = $1 FOR UPDATE', [req.params.id]);
            const level = rows[0];
            if (!level) return false;
            await client.query('DELETE FROM team_levels WHERE id = $1', [level.id]);
            await logAudit(client, {
                adminId: req.user.id,
                action: 'team_level_deleted',
                target: level.id,
                previousValue: { name: level.name },
            });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Team level not found.' });
        return res.json({ ok: true });
    } catch (error) { return next(error); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const [{ rows: members }, levelResult] = await Promise.all([
            pool.query("SELECT id, full_name, phone_number, created_at FROM users WHERE referred_by = $1 AND role = 'user'", [req.user.id]),
            req.user.team_level_id
                ? pool.query('SELECT * FROM team_levels WHERE id = $1', [req.user.team_level_id])
                : Promise.resolve({ rows: [] }),
        ]);
        return res.json({
            memberCount: members.length,
            members: members.map((member) => ({
                id: member.id,
                fullName: member.full_name,
                phoneNumber: member.phone_number,
                joinedAt: member.created_at,
            })),
            level: levelResult.rows[0] ? toPublicLevel(levelResult.rows[0]) : null,
        });
    } catch (error) { return next(error); }
});

router.get('/commissions', requireAuth, async (req, res, next) => {
    try {
        const configured = await getCountrySetting(pool, req.user.country_code, 'commissions');
        const { rows } = Array.isArray(configured)
            ? { rows: configured }
            : await pool.query('SELECT level, percent FROM commissions ORDER BY level ASC');
        return res.json({ commissions: rows });
    } catch (error) { return next(error); }
});

router.get('/invite-rewards', requireAuth, async (req, res, next) => {
    try {
        const configured = await getCountrySetting(pool, req.user.country_code, 'inviteRewards');
        const rewardRows = Array.isArray(configured)
            ? configured
            : (await pool.query('SELECT id, required_invites AS "requiredInvites", reward, enabled FROM invite_rewards')).rows;
        const rows = await Promise.all(rewardRows
            .filter((item) => item.enabled !== false && item.enabled !== 0)
            .map(async (item) => {
                const requiredInvites = item.requiredInvites ?? item.required_invites;
                const [claim, invited] = await Promise.all([
                    pool.query(
                        `SELECT 1 FROM reward_transactions
                         WHERE user_id = $1 AND type = 'invite_reward' AND reference_id = $2 LIMIT 1`,
                        [req.user.id, item.id],
                    ),
                    pool.query("SELECT COUNT(DISTINCT id)::int AS count FROM users WHERE referred_by = $1 AND role = 'user'", [req.user.id]),
                ]);
                return {
                    id: item.id,
                    requiredInvites,
                    reward: item.reward,
                    invitedCount: Number(invited.rows[0].count),
                    claimed: claim.rowCount > 0,
                };
            }));
        return res.json({
            inviteRewards: rows.map((row) => ({
                id: row.id,
                requiredInvites: Number(row.requiredInvites),
                reward: Number(row.reward),
                invitedCount: Number(row.invitedCount),
                claimed: row.claimed,
            })),
        });
    } catch (error) { return next(error); }
});

router.post('/invite-rewards/:id/claim', requireAuth, async (req, res, next) => {
    try {
        const result = await transaction(async (client) => {
            const { rows: users } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
            const user = users[0];
            if (!user) return { status: 404, error: 'User account not found.' };
            const countryRewards = await getCountrySetting(client, user.country_code, 'inviteRewards');
            const configuredReward = Array.isArray(countryRewards)
                ? countryRewards.find((item) => String(item.id) === String(req.params.id) && item.enabled !== false)
                : null;
            const legacyReward = Array.isArray(countryRewards)
                ? null
                : (await client.query('SELECT * FROM invite_rewards WHERE id = $1 AND enabled = 1', [req.params.id])).rows[0];
            const reward = configuredReward
                ? { ...configuredReward, required_invites: configuredReward.requiredInvites ?? configuredReward.required_invites }
                : legacyReward;
            if (!reward) return { status: 404, error: 'Invite reward not found or disabled.' };
            const existing = await client.query(
                "SELECT id FROM reward_transactions WHERE user_id = $1 AND type = 'invite_reward' AND reference_id = $2 FOR UPDATE",
                [user.id, reward.id],
            );
            if (existing.rowCount) return { status: 409, error: 'This invite reward has already been claimed.' };
            const invited = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE referred_by = $1 AND role = 'user'", [user.id]);
            const invitedCount = Number(invited.rows[0].count);
            if (invitedCount < Number(reward.required_invites)) {
                return {
                    status: 400,
                    error: `Invite at least ${Number(reward.required_invites)} friends before claiming this reward.`,
                    invitedCount,
                    requiredInvites: Number(reward.required_invites),
                };
            }
            const amount = Math.max(0, Math.round(Number(reward.reward)));
            const previousBalance = Number(user.balance);
            const newBalance = previousBalance + amount;
            await client.query(
                'UPDATE users SET balance = $1, commission_balance = commission_balance + $2 WHERE id = $3',
                [newBalance, amount, user.id],
            );
            await client.query(
                `INSERT INTO reward_transactions
                 (id, user_id, type, amount, source, reference_id, previous_balance, new_balance, status)
                 VALUES ($1, $2, 'invite_reward', $3, $4, $5, $6, $7, 'completed')`,
                [
                    uuid(), user.id, amount,
                    `Invite Reward: ${reward.required_invites} registered referrals`,
                    reward.id, previousBalance, newBalance,
                ],
            );
            return { ok: true, reward: amount, balance: newBalance };
        });
        if (result.error) return res.status(result.status).json({
            error: result.error,
            ...(result.invitedCount === undefined ? {} : { invitedCount: result.invitedCount, requiredInvites: result.requiredInvites }),
        });
        return res.json(result);
    } catch (error) { return next(error); }
});

router.get('/my-team', requireAuth, async (req, res, next) => {
    try {
        const [
            { rows: members },
            { rows: commissionLevels },
            { rows: levelMemberRows },
            { rows: earnings },
            { rows: qualified },
            { rows: levels },
        ] = await Promise.all([
            pool.query("SELECT id, full_name, phone_number, created_at FROM users WHERE referred_by = $1 AND role = 'user' ORDER BY created_at DESC", [req.user.id]),
            pool.query('SELECT level FROM commissions ORDER BY level ASC'),
            pool.query(`
                WITH RECURSIVE referral_tree(user_id, depth, path) AS (
                    SELECT id, 1, ARRAY[id]::text[] FROM users WHERE referred_by = $1 AND role = 'user'
                    UNION ALL
                    SELECT child.id, tree.depth + 1, tree.path || child.id
                    FROM users child
                    JOIN referral_tree tree ON child.referred_by = tree.user_id
                    WHERE child.role = 'user' AND tree.depth < $2 AND NOT child.id = ANY(tree.path)
                )
                SELECT depth, COUNT(*)::int AS member_count
                FROM referral_tree WHERE depth <= $2 GROUP BY depth
            `, [req.user.id, 10]),
            pool.query(
                `SELECT COALESCE(SUM(amount), 0) AS total FROM reward_transactions
                 WHERE user_id = $1 AND type = 'commission' AND status = 'completed'`,
                [req.user.id],
            ),
            pool.query(
                `SELECT COUNT(DISTINCT u.id)::int AS count FROM users u
                 JOIN product_purchases p ON p.user_id = u.id AND p.status = 'completed'
                 WHERE u.referred_by = $1 AND u.role = 'user'`,
                [req.user.id],
            ),
            pool.query("SELECT * FROM team_levels WHERE status = 'active' ORDER BY requirement ASC"),
        ]);
        const maximumCommissionLevel = Math.min(10, Math.max(0, ...commissionLevels.map((row) => Number(row.level))));
        const referralCountsByLevel = Object.fromEntries(commissionLevels.map(({ level }) => [Number(level), 0]));
        levelMemberRows.forEach(({ depth, member_count }) => {
            if (Object.hasOwn(referralCountsByLevel, Number(depth)) && Number(depth) <= maximumCommissionLevel) {
                referralCountsByLevel[Number(depth)] = Number(member_count);
            }
        });
        let currentLevel = null;
        let nextLevel = null;
        for (const level of levels) {
            if (members.length >= Number(level.requirement)) currentLevel = level;
            else { nextLevel = level; break; }
        }
        return res.json({
            referralCode: req.user.referral_code,
            memberCount: members.length,
            totalCommissionEarnings: Number(earnings[0].total),
            referralCountsByLevel,
            qualifiedMemberCount: Number(qualified[0].count),
            currentLevel: currentLevel ? toPublicLevel(currentLevel) : null,
            nextLevel: nextLevel ? toPublicLevel(nextLevel) : null,
            members,
        });
    } catch (error) { return next(error); }
});

module.exports = { router, toPublicLevel };
