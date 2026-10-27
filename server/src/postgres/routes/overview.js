const express = require('express');
const { pool } = require('../store');
const { requireAdmin } = require('../middleware');
const { COUNTRIES } = require('../../utils/countries');

const router = express.Router();

const metrics = [
    ['totalUsers', "SELECT COUNT(*) AS count FROM users WHERE role = 'user'"],
    ['activeUsers', "SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Active'"],
    ['activePurchasers', "SELECT COUNT(DISTINCT pp.user_id) AS count FROM product_purchases pp JOIN users u ON u.id = pp.user_id WHERE u.role = 'user' AND pp.status = 'completed'"],
    ['liveUsers', "SELECT COUNT(*) AS count FROM user_presence p JOIN users u ON u.id = p.user_id WHERE u.role = 'user' AND u.status = 'Active' AND p.last_seen_at >= CURRENT_TIMESTAMP - INTERVAL '20 seconds'"],
    ['blockedUsers', "SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Blocked'"],
    ['suspendedUsers', "SELECT COUNT(*) AS count FROM users WHERE role = 'user' AND status = 'Suspended'"],
    ['totalBalance', "SELECT COALESCE(SUM(balance), 0) AS total FROM users WHERE role = 'user'"],
    ['pendingDeposits', "SELECT COUNT(*) AS count FROM deposits WHERE status = 'pending'"],
    ['approvedDeposits', "SELECT COUNT(*) AS count FROM deposits WHERE status = 'approved'"],
    ['rejectedDeposits', "SELECT COUNT(*) AS count FROM deposits WHERE status = 'rejected'"],
    ['totalDeposits', "SELECT COALESCE(SUM(amount), 0) AS total FROM deposits WHERE status = 'approved'"],
    ['pendingWithdrawals', "SELECT COUNT(*) AS count FROM withdrawals WHERE status = 'pending'"],
    ['approvedWithdrawals', "SELECT COUNT(*) AS count FROM withdrawals WHERE status IN ('approved', 'paid')"],
    ['rejectedWithdrawals', "SELECT COUNT(*) AS count FROM withdrawals WHERE status = 'rejected'"],
    ['totalWithdrawals', "SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE status IN ('approved', 'paid')"],
    ['totalProducts', 'SELECT COUNT(*) AS count FROM products'],
    ['totalProductPurchases', "SELECT COUNT(*) AS count FROM product_purchases WHERE status = 'completed'"],
    ['totalPromoters', "SELECT COUNT(DISTINCT promoter_id) AS count FROM users WHERE promoter_id IS NOT NULL AND role = 'user'"],
    ['totalEarnings', "SELECT COALESCE(SUM(amount), 0) AS total FROM reward_transactions WHERE status = 'completed'"],
    ['totalSponsors', 'SELECT COUNT(*) AS count FROM sponsors'],
    ['giftCodesTotal', 'SELECT COUNT(*) AS count FROM gift_codes'],
    ['giftCodesActive', "SELECT COUNT(*) AS count FROM gift_codes WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)"],
    ['giftCodesInactive', "SELECT COUNT(*) AS count FROM gift_codes WHERE enabled = 0 OR (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP)"],
];

router.get('/', requireAdmin, async (_req, res, next) => {
    try {
        const [metricResults, depositsByCountryResult, withdrawalsByCountryResult, balancesByCountryResult, recentActionsResult] = await Promise.all([
            Promise.all(metrics.map(([, sql]) => pool.query(sql))),
            pool.query("SELECT u.country_code, COALESCE(SUM(d.amount), 0) AS total FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'approved' GROUP BY u.country_code"),
            pool.query("SELECT u.country_code, COALESCE(SUM(w.amount), 0) AS total FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.status IN ('approved', 'paid') GROUP BY u.country_code"),
            pool.query("SELECT country_code, COALESCE(SUM(balance), 0) AS total FROM users WHERE role = 'user' GROUP BY country_code"),
            pool.query(`
                SELECT a.*, admin.full_name AS admin_name, target.full_name AS target_user_name
                FROM audit_logs a
                LEFT JOIN users admin ON admin.id = a.admin_id
                LEFT JOIN users target ON target.id = a.target
                ORDER BY a.created_at DESC
                LIMIT 10
            `),
        ]);
        const values = Object.fromEntries(metrics.map(([name], index) => {
            const row = metricResults[index].rows[0];
            return [name, Number(row.count ?? row.total ?? 0)];
        }));
        const sumByCountry = (rows, code) => Number(rows.find((row) => row.country_code === code)?.total || 0);
        const moneyByCurrency = Object.values(COUNTRIES).map((country) => {
            const deposits = sumByCountry(depositsByCountryResult.rows, country.code);
            const withdrawals = sumByCountry(withdrawalsByCountryResult.rows, country.code);
            return {
                countryCode: country.code,
                currency: country.currency,
                deposits,
                withdrawals,
                remainingFunds: deposits - withdrawals,
                userBalances: sumByCountry(balancesByCountryResult.rows, country.code),
            };
        });
        return res.json({
            ...values,
            giftCodes: {
                total: values.giftCodesTotal,
                active: values.giftCodesActive,
                inactive: values.giftCodesInactive,
            },
            moneyByCurrency,
            recentActions: recentActionsResult.rows,
        });
    } catch (error) { return next(error); }
});

module.exports = { router };
