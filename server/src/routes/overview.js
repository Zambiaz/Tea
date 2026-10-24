const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { COUNTRIES } = require('../utils/countries');

const router = express.Router();

router.get('/', requireAdmin, (req, res) => {
    const count = (sql) => Number(db.prepare(sql).get().count || 0);
    const depositsByCountry = db.prepare("SELECT u.country_code, COALESCE(SUM(d.amount), 0) AS total FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'approved' GROUP BY u.country_code").all();
    const withdrawalsByCountry = db.prepare("SELECT u.country_code, COALESCE(SUM(w.amount), 0) AS total FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status IN ('approved', 'paid') GROUP BY u.country_code").all();
    const balancesByCountry = db.prepare("SELECT country_code, COALESCE(SUM(balance), 0) AS total FROM users WHERE role = 'user' GROUP BY country_code").all();
    const moneyByCurrency = Object.values(COUNTRIES).map((country) => {
        const deposits = Number(depositsByCountry.find((row) => row.country_code === country.code)?.total || 0);
        const withdrawals = Number(withdrawalsByCountry.find((row) => row.country_code === country.code)?.total || 0);
        const balance = Number(balancesByCountry.find((row) => row.country_code === country.code)?.total || 0);
        return { countryCode: country.code, currency: country.currency, deposits, withdrawals, remainingFunds: deposits - withdrawals, userBalances: balance };
    });
    const recentActions = db.prepare(`
        SELECT a.*, admin.full_name AS admin_name, target.full_name AS target_user_name
        FROM audit_logs a
        LEFT JOIN users admin ON admin.id = a.admin_id
        LEFT JOIN users target ON target.id = a.target
        ORDER BY a.created_at DESC
        LIMIT 10
    `).all();
    res.json({
        totalUsers: count("SELECT COUNT(*) AS count FROM users WHERE role = 'user'"),
        activeUsers: count("SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Active'"),
        activePurchasers: count("SELECT COUNT(DISTINCT pp.user_id) AS count FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.role = 'user' AND pp.status = 'completed'"),
        liveUsers: count("SELECT COUNT(*) AS count FROM user_presence p JOIN users u ON u.id = p.user_id WHERE u.role = 'user' AND u.status = 'Active' AND p.last_seen_at >= datetime('now', '-20 seconds')"),
        blockedUsers: count("SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Blocked'"),
        suspendedUsers: count("SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Suspended'"),
        totalBalance: Number(db.prepare("SELECT COALESCE(SUM(balance), 0) AS total FROM users WHERE role = 'user'").get().total || 0),
        pendingDeposits: count("SELECT COUNT(*) AS count FROM deposits WHERE status = 'pending'"),
        approvedDeposits: count("SELECT COUNT(*) AS count FROM deposits WHERE status = 'approved'"),
        rejectedDeposits: count("SELECT COUNT(*) AS count FROM deposits WHERE status = 'rejected'"),
        totalDeposits: Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE status = 'approved'").get().total || 0),
        pendingWithdrawals: count("SELECT COUNT(*) AS count FROM withdrawals WHERE status = 'pending'"),
        approvedWithdrawals: count("SELECT COUNT(*) AS count FROM withdrawals WHERE status IN ('approved', 'paid')"),
        rejectedWithdrawals: count("SELECT COUNT(*) AS count FROM withdrawals WHERE status = 'rejected'"),
        totalWithdrawals: Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status IN ('approved', 'paid')").get().total || 0),
        totalProducts: count('SELECT COUNT(*) AS count FROM products'),
        totalProductPurchases: count("SELECT COUNT(*) AS count FROM product_purchases WHERE status = 'completed'"),
        totalPromoters: count("SELECT COUNT(DISTINCT promoter_id) AS count FROM users WHERE promoter_id IS NOT NULL AND role = 'user'"),
        moneyByCurrency,
        totalEarnings: Number(db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM reward_transactions WHERE status = 'completed'").get().total || 0),
        totalSponsors: count('SELECT COUNT(*) AS count FROM sponsors'),
        giftCodes: {
            total: count('SELECT COUNT(*) AS count FROM gift_codes'),
            active: count("SELECT COUNT(*) AS count FROM gift_codes WHERE enabled = 1 AND (expires_at IS NULL OR julianday(expires_at) > julianday('now'))"),
            inactive: count("SELECT COUNT(*) AS count FROM gift_codes WHERE enabled = 0 OR (expires_at IS NOT NULL AND julianday(expires_at) <= julianday('now'))"),
        },
        recentActions,
    });
});

module.exports = { router };
