const express = require('express');
const { pool, transaction, uuid, getCountryConfig, getCountrySetting, getCountryProduct } = require('../store');
const { requireAuth, requireAdmin } = require('../middleware');
const { logAudit } = require('../audit');
const { COUNTRY_CODES } = require('../../utils/countries');

const router = express.Router();
const MAX_POSTGRES_INTEGER = 2147483647;

function parseStoredDate(value) {
    const text = String(value || '');
    return new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
}

function getProductStatus(purchase) {
    const durationDays = Math.max(0, Number(purchase.investment_duration_days || purchase.duration_days || 0));
    const start = parseStoredDate(purchase.created_at);
    const elapsedDays = Number.isFinite(start.getTime()) ? Math.max(0, Math.floor((Date.now() - start.getTime()) / 86400000)) : 0;
    const daysElapsed = durationDays > 0 ? Math.min(durationDays, elapsedDays) : elapsedDays;
    const daysRemaining = durationDays > 0 ? Math.max(0, durationDays - daysElapsed) : 0;
    const endDate = durationDays > 0 ? new Date(start.getTime() + durationDays * 86400000).toISOString() : null;
    const completed = durationDays > 0 && elapsedDays >= durationDays;
    return {
        durationDays,
        daysElapsed,
        daysRemaining,
        endDate,
        progress: durationDays > 0 ? Math.min(100, Math.round(daysElapsed / durationDays * 100)) : 0,
        completed,
    };
}

function toPublicProduct(product) {
    const dailyIncome = Number(product.daily_income_amount || Math.round(Number(product.price || 0) * Number(product.daily_income_percent || 0) / 100));
    return {
        id: product.id,
        name: product.name,
        description: product.description || '',
        category: product.category || '',
        price: Number(product.price || 0),
        stock: Number(product.stock || 0),
        totalSlots: Number(product.total_slots || 1000),
        status: product.status || (product.enabled ? 'active' : 'inactive'),
        imageUrl: product.image_url || null,
        image_url: product.image_url || null,
        imageProxyUrl: product.image_url ? `/api/products/${product.id}/image` : null,
        enabled: Boolean(product.enabled),
        availability: product.availability,
        productUrl: product.product_url || null,
        product_url: product.product_url || null,
        cardColor: normalizeColor(product.card_color, '#363b45'),
        headerColor: normalizeColor(product.header_color, '#73777d'),
        buttonColor: normalizeColor(product.button_color, '#6b432b'),
        dailyIncome,
        totalIncome: Number(product.total_income || 0),
        term_days: 0,
        duration_days: 0,
        createdAt: product.created_at,
        investmentDurationDays: Number(product.investment_duration_days || 0),
        dailyIncomeAmount: dailyIncome,
        dailyIncomePercent: Number(product.daily_income_percent || 0),
    };
}

function normalizeImageUrl(value) {
    if (!value) return null;
    const text = String(value).trim();
    try {
        const parsed = new URL(text);
        if (parsed.hostname === 'www.google.com' && parsed.pathname === '/imgres') return parsed.searchParams.get('imgurl') || text;
    } catch (_) {}
    return text;
}

function normalizeColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback;
}

function validateProduct({
    name, category, price, stock, totalSlots = 1000, status, imageUrl, productUrl,
    cardColor, headerColor, buttonColor, investmentDurationDays = 0,
    dailyIncomeAmount = 0, dailyIncomePercent = 0, totalIncome = 0,
}) {
    if (!String(name || '').trim()) return 'Product name is required.';
    if (!String(category || '').trim()) return 'Category is required.';
    if (!Number.isSafeInteger(Number(price)) || Number(price) < 0 || Number(price) > MAX_POSTGRES_INTEGER) return `Price must be a whole number from zero to ${MAX_POSTGRES_INTEGER}.`;
    if (!Number.isSafeInteger(Number(stock)) || Number(stock) < 0 || Number(stock) > MAX_POSTGRES_INTEGER) return `Stock must be a whole number from zero to ${MAX_POSTGRES_INTEGER}.`;
    if (!Number.isSafeInteger(Number(totalSlots)) || Number(totalSlots) < 1 || Number(totalSlots) > MAX_POSTGRES_INTEGER) return `Total slots must be a whole number from 1 to ${MAX_POSTGRES_INTEGER}.`;
    if (!['active', 'sold_out', 'open_soon', 'inactive'].includes(String(status))) return 'Status must be available, sold out, open soon, or hidden.';
    if (imageUrl && String(imageUrl).length > 2000) return 'Product image URL is too long.';
    if (imageUrl) {
        try {
            const parsed = new URL(imageUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) return 'Product image must use http or https.';
            if (parsed.hostname === 'www.google.com' && parsed.pathname === '/imgres') return 'Use the direct image URL, not a Google image-results page.';
            if (parsed.hostname === 'www.facebook.com' || parsed.hostname === 'facebook.com') return 'Use a direct image URL, not a Facebook page URL.';
        } catch (_) { return 'Product image URL must be valid.'; }
    }
    if (productUrl) {
        try {
            if (!['http:', 'https:'].includes(new URL(productUrl).protocol)) return 'Product link must use http or https.';
        } catch (_) { return 'Product link must be a valid URL.'; }
    }
    if (![cardColor, headerColor, buttonColor].every((color) => !color || /^#[0-9a-f]{6}$/i.test(String(color)))) return 'Product colors must be six-digit hex colors.';
    if (!Number.isSafeInteger(Number(investmentDurationDays)) || Number(investmentDurationDays) < 0 || Number(investmentDurationDays) > MAX_POSTGRES_INTEGER) return 'Investment duration must be a supported whole number zero or greater.';
    if (!Number.isSafeInteger(Number(dailyIncomeAmount)) || Number(dailyIncomeAmount) < 0 || Number(dailyIncomeAmount) > MAX_POSTGRES_INTEGER) return 'Daily income amount must be a supported whole number zero or greater.';
    if (!Number.isFinite(Number(dailyIncomePercent)) || Number(dailyIncomePercent) < 0 || Number(dailyIncomePercent) > 100) return 'Daily income percent must be between 0 and 100.';
    if (!Number.isSafeInteger(Number(totalIncome)) || Number(totalIncome) < 0 || Number(totalIncome) > MAX_POSTGRES_INTEGER) return 'Total income must be a supported whole number zero or greater.';
    return null;
}

router.get('/', requireAuth, async (req, res, next) => {
    try {
        res.setHeader('Cache-Control', 'private, no-store');
        const config = await getCountryConfig(pool, req.user.country_code);
        if (!config?.enabled) return res.status(403).json({ error: 'Products are unavailable for your country.' });
        const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
        const products = rows
            .map((product) => getCountryProduct(config, product))
            .filter((product) => product.enabled !== false && Number(product.enabled) !== 0 &&
                product.status !== 'inactive' && ['active', 'sold_out', 'open_soon'].includes(product.status));
        return res.json({ products: products.map(toPublicProduct) });
    } catch (error) { return next(error); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
    try {
        const [{ rows: purchased }, { rows: purchases }] = await Promise.all([
            pool.query("SELECT DISTINCT product_id FROM product_purchases WHERE user_id = $1 AND status = 'completed'", [req.user.id]),
            pool.query(`
                SELECT pp.id, pp.product_id, pp.price, pp.status, pp.created_at, p.name, p.category,
                       p.investment_duration_days, p.duration_days,
                       COALESCE((SELECT MAX(l.amount) FROM product_earning_ledger l WHERE l.purchase_id = pp.id),
                                p.daily_income_amount, 0) AS active_income
                FROM product_purchases pp
                JOIN products p ON p.id = pp.product_id
                WHERE pp.user_id = $1 AND pp.status = 'completed'
                ORDER BY pp.created_at DESC
            `, [req.user.id]),
        ]);
        return res.json({
            products: purchases.map((purchase) => ({
                ...purchase,
                ...getProductStatus(purchase),
                dailyIncome: Number(purchase.active_income || 0),
            })),
            purchasedProductIds: purchased.map((row) => row.product_id),
        });
    } catch (error) { return next(error); }
});

router.get('/all', requireAdmin, async (req, res, next) => {
    try {
        const countryCode = String(req.query.country || 'RW').toUpperCase();
        const config = await getCountryConfig(pool, countryCode);
        if (!config) return res.status(400).json({ error: 'Unsupported country code.' });
        res.setHeader('Cache-Control', 'private, no-store');
        const { rows } = await pool.query('SELECT * FROM products ORDER BY created_at DESC');
        return res.json({ products: rows.map((product) => toPublicProduct(getCountryProduct(config, product))) });
    } catch (error) { return next(error); }
});

router.get('/:id/image', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT image_url FROM products WHERE id = $1', [req.params.id]);
        if (!rows[0]?.image_url) return res.status(404).end();
        let imageUrl;
        try { imageUrl = new URL(rows[0].image_url); } catch (_) { return res.status(404).end(); }
        if (!['http:', 'https:'].includes(imageUrl.protocol)) return res.status(404).end();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(imageUrl, { signal: controller.signal, redirect: 'follow' });
            const contentType = response.headers.get('content-type') || '';
            if (!response.ok || !contentType.startsWith('image/')) return res.status(404).end();
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.setHeader('Content-Type', contentType);
            return res.send(Buffer.from(await response.arrayBuffer()));
        } finally {
            clearTimeout(timeout);
        }
    } catch (_) {
        return res.status(404).end();
    }
});

router.post('/:id/purchase', requireAuth, async (req, res, next) => {
    try {
        const purchaseId = uuid();
        const result = await transaction(async (client) => {
            const { rows: users } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
            const user = users[0];
            if (!user || user.product_purchase_blocked) return { status: 403, error: 'Product purchases are disabled for this account.' };
            await client.query('SELECT country_code FROM country_configs WHERE country_code = $1 FOR UPDATE', [user.country_code]);
            const countryConfig = await getCountryConfig(client, user.country_code);
            if (!countryConfig?.enabled) return { status: 403, error: 'Purchases are unavailable for your country.' };
            const { rows: productRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
            const baseProduct = productRows[0];
            const product = baseProduct && getCountryProduct(countryConfig, baseProduct);
            if (product && (product.enabled === false || Number(product.enabled) === 0 || product.status !== 'active')) {
                return { status: 404, error: 'Product not found or inactive in your country.' };
            }
            if (!product) return { status: 404, error: 'Product not found or inactive.' };
            const alreadyPurchased = await client.query(
                "SELECT 1 FROM product_purchases WHERE user_id = $1 AND product_id = $2 AND status = 'completed' LIMIT 1",
                [user.id, product.id],
            );
            if (alreadyPurchased.rowCount) return { status: 409, error: 'You have already purchased this product.' };
            if (Number(product.stock || 0) <= 0) return { status: 409, error: 'Product is out of stock.' };
            if (Number(user.balance) < Number(product.price)) return { status: 400, error: 'Insufficient balance to buy this product.' };
            const countryProducts = { ...countryConfig.products };
            const currentCountryProduct = { ...baseProduct, ...countryProducts[product.id] };
            const remainingStock = Number(currentCountryProduct.stock || 0);
            if (remainingStock <= 0) return { status: 409, error: 'Product is out of stock.' };
            const newBalance = Number(user.balance) - Number(product.price);
            countryProducts[product.id] = { ...countryProducts[product.id], stock: remainingStock - 1 };
            await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);
            await client.query(
                'UPDATE country_configs SET products_json = $1, updated_at = CURRENT_TIMESTAMP WHERE country_code = $2',
                [JSON.stringify(countryProducts), countryConfig.code],
            );
            await client.query(
                "INSERT INTO product_purchases (id, user_id, product_id, price, status) VALUES ($1, $2, $3, $4, 'completed')",
                [purchaseId, user.id, product.id, product.price],
            );
            await client.query(
                `INSERT INTO transactions
                 (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by)
                 VALUES ($1, $2, 'adjustment', $3, $4, $5, 'Product purchase', $6, 'user')`,
                [uuid(), user.id, -Number(product.price), user.balance, newBalance, purchaseId],
            );
            const dailyAmount = Math.max(0, Math.round(Number(product.daily_income_amount || product.daily_income_percent || 0)));
            const durationDays = Math.max(0, Number(product.investment_duration_days || product.duration_days || 0));
            if (dailyAmount > 0 && durationDays > 0) {
                await client.query(
                    `INSERT INTO product_earning_ledger
                     (id, purchase_id, user_id, product_id, amount, cycle_day, next_credit_at, status)
                     VALUES ($1, $2, $3, $4, $5, 1, CURRENT_TIMESTAMP + INTERVAL '24 hours', 'active')`,
                    [uuid(), purchaseId, user.id, product.id, dailyAmount],
                );
            }
            const { rows: bonuses } = await client.query(
                "SELECT * FROM user_bonuses WHERE user_id = $1 AND status = 'PENDING' AND product_required = 1 FOR UPDATE",
                [user.id],
            );
            const pendingBonus = bonuses[0];
            const setting = await getCountrySetting(client, countryConfig.code, 'welcomeBonus') || {};
            const hasDeposit = pendingBonus
                ? await client.query(
                    "SELECT 1 FROM deposits WHERE user_id = $1 AND status = 'approved' AND amount >= $2 LIMIT 1",
                    [user.id, Number(setting.minimumDeposit || 0)],
                )
                : null;
            if (pendingBonus && (!pendingBonus.deposit_required || hasDeposit.rowCount > 0)) {
                await client.query("UPDATE user_bonuses SET status = 'UNLOCKED', unlocked_at = CURRENT_TIMESTAMP WHERE id = $1", [pendingBonus.id]);
                await client.query(
                    `UPDATE reward_transactions SET status = 'completed'
                     WHERE user_id = $1 AND type = 'welcome_bonus' AND reference_id = $2`,
                    [user.id, pendingBonus.id],
                );
            }
            return { purchaseId };
        });
        if (result.error) return res.status(result.status).json({ error: result.error });
        return res.status(201).json({ ok: true, purchaseId: result.purchaseId });
    } catch (error) { return next(error); }
});

router.post('/', requireAdmin, async (req, res, next) => {
    try {
        const {
            name, description, category, price, stock, totalSlots, status, imageUrl, productUrl,
            cardColor, headerColor, buttonColor, investmentDurationDays, dailyIncomeAmount,
            dailyIncomePercent, totalIncome,
        } = req.body || {};
        const countryCode = req.body?.countryCode ? String(req.body.countryCode).toUpperCase() : null;
        if (countryCode && !COUNTRY_CODES.includes(countryCode)) return res.status(400).json({ error: 'Unsupported country code.' });
        const normalizedImageUrl = normalizeImageUrl(imageUrl);
        const validationError = validateProduct({
            name, category, price, stock, totalSlots, status, imageUrl: normalizedImageUrl, productUrl,
            cardColor, headerColor, buttonColor, investmentDurationDays,
            dailyIncomeAmount: dailyIncomeAmount ?? dailyIncomePercent,
            dailyIncomePercent,
            totalIncome,
        });
        if (validationError) return res.status(400).json({ error: validationError });
        const id = uuid();
        const product = await transaction(async (client) => {
            await client.query(
                `INSERT INTO products
                 (id, name, description, category, price, stock, total_slots, status, availability, image_url,
                  product_url, card_color, header_color, button_color, enabled, investment_duration_days,
                  daily_income_amount, daily_income_percent, total_income)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
                [
                    id, String(name).trim(), String(description || '').trim(), String(category).trim(), Number(price),
                    Number(stock), Math.max(1, Number(totalSlots) || 1000), status,
                    status === 'active' ? 'In Stock' : 'Out of Stock',
                    normalizedImageUrl || null, productUrl ? String(productUrl).trim() : null,
                    normalizeColor(cardColor, '#363b45'), normalizeColor(headerColor, '#73777d'),
                    normalizeColor(buttonColor, '#6b432b'), status !== 'inactive' ? 1 : 0,
                    Number(investmentDurationDays || 0), Number(dailyIncomeAmount ?? dailyIncomePercent ?? 0),
                    Number(dailyIncomePercent || 0), Number(totalIncome || 0),
                ],
            );
            if (countryCode) {
                const productSettings = {
                    price: Number(price),
                    stock: Number(stock),
                    total_slots: Math.max(1, Number(totalSlots) || 1000),
                    investment_duration_days: Number(investmentDurationDays || 0),
                    daily_income_amount: Number(dailyIncomeAmount ?? dailyIncomePercent ?? 0),
                    daily_income_percent: Number(dailyIncomePercent || 0),
                    total_income: Number(totalIncome || 0),
                };
                for (const code of COUNTRY_CODES) {
                    const config = await getCountryConfig(client, code);
                    const countryProductSettings = {
                        ...productSettings,
                        status: code === countryCode ? status : 'inactive',
                        enabled: code === countryCode && status !== 'inactive',
                    };
                    await client.query(
                        'UPDATE country_configs SET products_json = $1, updated_at = CURRENT_TIMESTAMP WHERE country_code = $2',
                        [JSON.stringify({ ...config.products, [id]: countryProductSettings }), code],
                    );
                }
            }
            await logAudit(client, {
                adminId: req.user.id,
                action: 'product_created',
                target: id,
                newValue: { name, category, price, stock, status, imageUrl, countryCode },
            });
            const { rows } = await client.query('SELECT * FROM products WHERE id = $1', [id]);
            return rows[0];
        });
        return res.status(201).json({ product: toPublicProduct(product) });
    } catch (error) { return next(error); }
});

router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
        const product = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return null;
            const body = req.body || {};
            const next = {
                name: body.name ?? existing.name,
                description: body.description ?? existing.description,
                category: body.category ?? existing.category,
                price: body.price ?? existing.price,
                stock: body.stock ?? existing.stock,
                status: body.status ?? existing.status,
                imageUrl: normalizeImageUrl(body.imageUrl ?? existing.image_url),
                productUrl: body.productUrl ?? existing.product_url,
                cardColor: body.cardColor ?? existing.card_color,
                headerColor: body.headerColor ?? existing.header_color,
                buttonColor: body.buttonColor ?? existing.button_color,
                investmentDurationDays: body.investmentDurationDays ?? existing.investment_duration_days,
                dailyIncomeAmount: body.dailyIncomeAmount ?? body.dailyIncomePercent ?? existing.daily_income_amount ?? existing.daily_income_percent,
                dailyIncomePercent: body.dailyIncomePercent ?? existing.daily_income_percent ?? 0,
                totalSlots: body.totalSlots ?? existing.total_slots ?? 1000,
                totalIncome: body.totalIncome ?? existing.total_income,
            };
            const validationError = validateProduct(next);
            if (validationError) return { error: validationError };
            await client.query(
                `UPDATE products SET name = $1, description = $2, category = $3, price = $4, stock = $5,
                 total_slots = $6, status = $7, availability = $8, image_url = $9, product_url = $10,
                 card_color = $11, header_color = $12, button_color = $13, enabled = $14,
                 investment_duration_days = $15, daily_income_amount = $16, daily_income_percent = $17,
                 total_income = $18 WHERE id = $19`,
                [
                    String(next.name).trim(), String(next.description || '').trim(), String(next.category).trim(),
                    Number(next.price), Number(next.stock), Math.max(1, Number(next.totalSlots) || 1000),
                    next.status, next.status === 'active' ? 'In Stock' : 'Out of Stock',
                    next.imageUrl ? String(next.imageUrl).trim() : null,
                    next.productUrl ? String(next.productUrl).trim() : null,
                    normalizeColor(next.cardColor, '#363b45'), normalizeColor(next.headerColor, '#73777d'),
                    normalizeColor(next.buttonColor, '#6b432b'), next.status !== 'inactive' ? 1 : 0,
                    Number(next.investmentDurationDays), Number(next.dailyIncomeAmount),
                    Number(next.dailyIncomePercent), Number(next.totalIncome), existing.id,
                ],
            );
            await logAudit(client, {
                adminId: req.user.id,
                action: 'product_updated',
                target: existing.id,
                previousValue: existing,
                newValue: next,
            });
            const updated = await client.query('SELECT * FROM products WHERE id = $1', [existing.id]);
            return updated.rows[0];
        });
        if (!product) return res.status(404).json({ error: 'Product not found.' });
        if (product.error) return res.status(400).json({ error: product.error });
        return res.json({ product: toPublicProduct(product) });
    } catch (error) { return next(error); }
});

router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
        const deleted = await transaction(async (client) => {
            const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
            const existing = rows[0];
            if (!existing) return false;
            await client.query('DELETE FROM products WHERE id = $1', [existing.id]);
            for (const code of COUNTRY_CODES) {
                const config = await getCountryConfig(client, code);
                const products = { ...config.products };
                delete products[existing.id];
                await client.query(
                    'UPDATE country_configs SET products_json = $1, updated_at = CURRENT_TIMESTAMP WHERE country_code = $2',
                    [JSON.stringify(products), code],
                );
            }
            await logAudit(client, { adminId: req.user.id, action: 'product_deleted', target: existing.id, previousValue: existing });
            return true;
        });
        if (!deleted) return res.status(404).json({ error: 'Product not found.' });
        return res.status(204).end();
    } catch (error) { return next(error); }
});

module.exports = { router, getProductStatus, toPublicProduct, validateProduct, normalizeColor };
