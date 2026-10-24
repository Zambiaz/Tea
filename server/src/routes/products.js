// Products (SHARE tab). Public GET for users (enabled only); full CRUD for admin.
// Products: public read access for users and server-authorized CRUD for admins.
const express = require('express');
const { db, uuid } = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../utils/auditLogger');
const { COUNTRY_CODES, getCountryConfig, getCountryProduct, getCountrySetting } = require('../utils/countries');

const router = express.Router();

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
    return { durationDays, daysElapsed, daysRemaining, endDate, progress: durationDays > 0 ? Math.min(100, Math.round((daysElapsed / durationDays) * 100)) : 0, completed };
}

function isActivePurchase(purchase) {
    return purchase.status === 'completed' && !getProductStatus(purchase).completed;
}

router.get('/', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const config = getCountryConfig(db, req.user.country_code);
    if (!config?.enabled) return res.status(403).json({ error: 'Products are unavailable for your country.' });
    const rows = db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
    const products = rows
        .map((product) => getCountryProduct(db, config.code, product))
        .filter((product) => product.enabled !== false && Number(product.enabled) !== 0 &&
            product.status !== 'inactive' && ['active', 'sold_out', 'open_soon'].includes(product.status));
    res.json({ products: products.map(toPublicProduct) });
});

router.get('/mine', requireAuth, (req, res) => {
    const purchasedProductIds = db.prepare("SELECT DISTINCT product_id FROM product_purchases WHERE user_id = ? AND status = 'completed'").all(req.user.id).map((row) => row.product_id);
    const purchases = db.prepare(`
        SELECT pp.id, pp.product_id, pp.price, pp.status, pp.created_at, p.name, p.category,
               p.investment_duration_days, p.duration_days,
               COALESCE(MAX(l.amount), p.daily_income_amount, 0) AS active_income
        FROM product_purchases pp
        JOIN products p ON p.id = pp.product_id
        LEFT JOIN product_earning_ledger l ON l.purchase_id = pp.id
        WHERE pp.user_id = ? AND pp.status = 'completed'
        GROUP BY pp.id
        ORDER BY pp.created_at DESC
    `).all(req.user.id).map((purchase) => ({ ...purchase, ...getProductStatus(purchase), dailyIncome: Number(purchase.active_income || 0) }));
    res.json({ products: purchases, purchasedProductIds });
});

router.get('/all', requireAdmin, (req, res) => {
    const countryCode = String(req.query.country || 'RW').toUpperCase();
    const config = getCountryConfig(db, countryCode);
    if (!config) return res.status(400).json({ error: 'Unsupported country code.' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ products: db.prepare('SELECT * FROM products ORDER BY created_at DESC').all().map((product) => toPublicProduct(getCountryProduct(db, countryCode, product))) });
});

router.get('/:id/image', async (req, res) => {
    const product = db.prepare('SELECT image_url FROM products WHERE id = ?').get(req.params.id);
    if (!product?.image_url) return res.status(404).end();
    let imageUrl;
    try { imageUrl = new URL(product.image_url); } catch (_) { return res.status(404).end(); }
    if (!['http:', 'https:'].includes(imageUrl.protocol)) return res.status(404).end();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(imageUrl, { signal: controller.signal, redirect: 'follow' });
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !contentType.startsWith('image/')) return res.status(404).end();
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('Content-Type', contentType);
        res.send(Buffer.from(await response.arrayBuffer()));
    } catch (_) {
        res.status(404).end();
    } finally {
        clearTimeout(timeout);
    }
});

router.post('/:id/purchase', requireAuth, (req, res) => {
    const purchaseId = uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
        if (req.user.product_purchase_blocked) { db.exec('ROLLBACK'); return res.status(403).json({ error: 'Product purchases are disabled for this account.' }); }
        const countryConfig = getCountryConfig(db, req.user.country_code);
        if (!countryConfig?.enabled) { db.exec('ROLLBACK'); return res.status(403).json({ error: 'Purchases are unavailable for your country.' }); }
        const baseProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
        const product = baseProduct && getCountryProduct(db, countryConfig.code, baseProduct);
        if (product && (product.enabled === false || Number(product.enabled) === 0 || product.status !== 'active')) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Product not found or inactive in your country.' }); }
        if (!product) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Product not found or inactive.' }); }
        const alreadyPurchased = db.prepare("SELECT 1 FROM product_purchases WHERE user_id = ? AND product_id = ? AND status = 'completed' LIMIT 1").get(req.user.id, product.id);
        if (alreadyPurchased) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'You have already purchased this product.' }); }
        if (Number(product.stock || 0) <= 0) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Product is out of stock.' }); }
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        if (Number(user.balance) < Number(product.price)) { db.exec('ROLLBACK'); return res.status(400).json({ error: 'Insufficient balance to buy this product.' }); }
        const newBalance = Number(user.balance) - Number(product.price);
        db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, req.user.id);
        const countryProducts = { ...countryConfig.products };
        const currentCountryProduct = { ...baseProduct, ...countryProducts[product.id] };
        const remainingStock = Number(currentCountryProduct.stock || 0);
        if (remainingStock <= 0) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Product is out of stock.' }); }
        countryProducts[product.id] = { ...countryProducts[product.id], stock: remainingStock - 1 };
        db.prepare("UPDATE country_configs SET products_json = ?, updated_at = datetime('now') WHERE country_code = ?")
            .run(JSON.stringify(countryProducts), countryConfig.code);
        db.prepare("INSERT INTO product_purchases (id, user_id, product_id, price, status) VALUES (?, ?, ?, ?, 'completed')").run(purchaseId, req.user.id, product.id, product.price);
        db.prepare("INSERT INTO transactions (id, user_id, type, amount, previous_balance, new_balance, reason, reference_id, performed_by) VALUES (?, ?, 'adjustment', ?, ?, ?, 'Product purchase', ?, 'user')").run(uuid(), req.user.id, -product.price, user.balance, newBalance, purchaseId);

        const dailyAmount = Math.max(0, Math.round(Number(product.daily_income_amount || product.daily_income_percent || 0)));
        const durationDays = Math.max(0, Number(product.investment_duration_days || product.duration_days || 0));
        if (dailyAmount > 0 && durationDays > 0) {
            db.prepare('INSERT INTO product_earning_ledger (id, purchase_id, user_id, product_id, amount, cycle_day, next_credit_at, status) VALUES (?, ?, ?, ?, ?, 1, datetime(\'now\', \'+24 hours\'), \'active\')')
                .run(uuid(), purchaseId, req.user.id, product.id, dailyAmount);
        }

        const pendingBonus = db.prepare("SELECT * FROM user_bonuses WHERE user_id = ? AND status = 'PENDING' AND product_required = 1").get(req.user.id);
        const setting = getCountrySetting(db, countryConfig.code, 'welcomeBonus') || {};
        const hasDeposit = pendingBonus ? !!db.prepare("SELECT 1 FROM deposits WHERE user_id = ? AND status = 'approved' AND amount >= ? LIMIT 1").get(req.user.id, Number(setting.minimumDeposit || 0)) : false;
        if (pendingBonus && (!pendingBonus.deposit_required || hasDeposit)) {
            db.prepare("UPDATE user_bonuses SET status = 'UNLOCKED', unlocked_at = datetime('now') WHERE id = ?").run(pendingBonus.id);
            db.prepare("UPDATE reward_transactions SET status = 'completed' WHERE user_id = ? AND type = 'welcome_bonus' AND reference_id = ?").run(req.user.id, pendingBonus.id);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        return res.status(500).json({ error: 'Unable to complete product purchase.' });
    }
    res.status(201).json({ ok: true, purchaseId });
});

router.post('/', requireAdmin, (req, res) => {
    const { name, description, category, price, stock, totalSlots, status, imageUrl, productUrl, cardColor, headerColor, buttonColor, investmentDurationDays, dailyIncomeAmount, dailyIncomePercent, totalIncome } = req.body || {};
    const countryCode = req.body?.countryCode ? String(req.body.countryCode).toUpperCase() : null;
    if (countryCode && !COUNTRY_CODES.includes(countryCode)) return res.status(400).json({ error: 'Unsupported country code.' });
    const normalizedImageUrl = normalizeImageUrl(imageUrl);
    const validationError = validateProduct({ name, category, price, stock, totalSlots, status, imageUrl: normalizedImageUrl, productUrl, cardColor, headerColor, buttonColor, investmentDurationDays, dailyIncomeAmount: dailyIncomeAmount ?? dailyIncomePercent, dailyIncomePercent, totalIncome });
    if (validationError) return res.status(400).json({ error: validationError });
    const id = uuid();
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('INSERT INTO products (id, name, description, category, price, stock, total_slots, status, availability, image_url, product_url, card_color, header_color, button_color, enabled, investment_duration_days, daily_income_amount, daily_income_percent, total_income) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(id, String(name).trim(), String(description || '').trim(), String(category).trim(), Number(price), Number(stock), Math.max(1, Number(totalSlots) || 1000), status, status === 'active' ? 'In Stock' : 'Out of Stock', normalizedImageUrl || null, productUrl ? String(productUrl).trim() : null, normalizeColor(cardColor, '#363b45'), normalizeColor(headerColor, '#73777d'), normalizeColor(buttonColor, '#6b432b'), status !== 'inactive' ? 1 : 0, Number(investmentDurationDays), Number(dailyIncomeAmount ?? dailyIncomePercent ?? 0), Number(dailyIncomePercent || 0), Number(totalIncome));
        if (countryCode) {
            const productSettings = {
                price: Number(price),
                stock: Number(stock),
                total_slots: Math.max(1, Number(totalSlots) || 1000),
                investment_duration_days: Number(investmentDurationDays),
                daily_income_amount: Number(dailyIncomeAmount ?? dailyIncomePercent ?? 0),
                daily_income_percent: Number(dailyIncomePercent || 0),
                total_income: Number(totalIncome),
            };
            for (const code of COUNTRY_CODES) {
                const config = getCountryConfig(db, code);
                const countryProductSettings = {
                    ...productSettings,
                    status: code === countryCode ? status : 'inactive',
                    enabled: code === countryCode && status !== 'inactive',
                };
                db.prepare("UPDATE country_configs SET products_json = ?, updated_at = datetime('now') WHERE country_code = ?")
                    .run(JSON.stringify({ ...config.products, [id]: countryProductSettings }), code);
            }
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }

    logAudit({ adminId: req.user.id, action: 'product_created', target: id, newValue: { name, category, price, stock, status, imageUrl, countryCode } });
    res.status(201).json({ product: toPublicProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) });
});

router.put('/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found.' });

    const next = {
        name: req.body.name ?? existing.name,
        description: req.body.description ?? existing.description,
        category: req.body.category ?? existing.category,
        price: req.body.price ?? existing.price,
        stock: req.body.stock ?? existing.stock,
        status: req.body.status ?? existing.status,
        imageUrl: normalizeImageUrl(req.body.imageUrl ?? existing.image_url),
        productUrl: req.body.productUrl ?? existing.product_url,
        cardColor: req.body.cardColor ?? existing.card_color,
        headerColor: req.body.headerColor ?? existing.header_color,
        buttonColor: req.body.buttonColor ?? existing.button_color,
        investmentDurationDays: req.body.investmentDurationDays ?? existing.investment_duration_days,
        dailyIncomeAmount: req.body.dailyIncomeAmount ?? req.body.dailyIncomePercent ?? existing.daily_income_amount ?? existing.daily_income_percent,
        dailyIncomePercent: req.body.dailyIncomePercent ?? existing.daily_income_percent ?? 0,
        totalSlots: req.body.totalSlots ?? existing.total_slots ?? 1000,
        totalIncome: req.body.totalIncome ?? existing.total_income,
    };
    const validationError = validateProduct(next);
    if (validationError) return res.status(400).json({ error: validationError });
    db.prepare('UPDATE products SET name = ?, description = ?, category = ?, price = ?, stock = ?, total_slots = ?, status = ?, availability = ?, image_url = ?, product_url = ?, card_color = ?, header_color = ?, button_color = ?, enabled = ?, investment_duration_days = ?, daily_income_amount = ?, daily_income_percent = ?, total_income = ? WHERE id = ?')
        .run(String(next.name).trim(), String(next.description || '').trim(), String(next.category).trim(), Number(next.price), Number(next.stock), Math.max(1, Number(next.totalSlots) || 1000), next.status, next.status === 'active' ? 'In Stock' : 'Out of Stock', next.imageUrl ? String(next.imageUrl).trim() : null, next.productUrl ? String(next.productUrl).trim() : null, normalizeColor(next.cardColor, '#363b45'), normalizeColor(next.headerColor, '#73777d'), normalizeColor(next.buttonColor, '#6b432b'), next.status !== 'inactive' ? 1 : 0, Number(next.investmentDurationDays), Number(next.dailyIncomeAmount), Number(next.dailyIncomePercent), Number(next.totalIncome), existing.id);

    logAudit({ adminId: req.user.id, action: 'product_updated', target: existing.id, previousValue: existing, newValue: next });
    res.json({ product: toPublicProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id)) });
});

function toPublicProduct(product) {
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
        enabled: !!product.enabled,
        availability: product.availability,
        productUrl: product.product_url || null,
        product_url: product.product_url || null,
        cardColor: normalizeColor(product.card_color, '#363b45'),
        headerColor: normalizeColor(product.header_color, '#73777d'),
        buttonColor: normalizeColor(product.button_color, '#6b432b'),
        productUrl: product.product_url || null,
        dailyIncome: Number(product.daily_income_amount || Math.round(Number(product.price || 0) * Number(product.daily_income_percent || 0) / 100)),
        totalIncome: 0,
        term_days: 0,
        duration_days: 0,
        createdAt: product.created_at,
        investmentDurationDays: Number(product.investment_duration_days || 0),
        dailyIncomeAmount: Number(product.daily_income_amount || Math.round(Number(product.price || 0) * Number(product.daily_income_percent || 0) / 100)),
        dailyIncomePercent: Number(product.daily_income_percent || 0),
        totalIncome: Number(product.total_income || 0),
    };
}

function normalizeImageUrl(value) {
    if (!value) return null;
    const text = String(value).trim();
    try {
        const parsed = new URL(text);
        if (parsed.hostname === 'www.google.com' && parsed.pathname === '/imgres') {
            return parsed.searchParams.get('imgurl') || text;
        }
    } catch (_) { /* validation reports invalid URLs below */ }
    return text;
}

function normalizeColor(value, fallback) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : fallback; }

function validateProduct({ name, category, price, stock, totalSlots = 1000, status, imageUrl, productUrl, cardColor, headerColor, buttonColor, investmentDurationDays = 0, dailyIncomeAmount = 0, dailyIncomePercent = 0, totalIncome = 0 }) {
    if (!String(name || '').trim()) return 'Product name is required.';
    if (!String(category || '').trim()) return 'Category is required.';
    if (!Number.isFinite(Number(price)) || Number(price) < 0) return 'Price must be zero or greater.';
    if (!Number.isInteger(Number(stock)) || Number(stock) < 0) return 'Stock must be a whole number zero or greater.';
    if (!Number.isInteger(Number(totalSlots)) || Number(totalSlots) < 1) return 'Total slots must be at least 1.';
    if (!['active', 'sold_out', 'open_soon', 'inactive'].includes(String(status))) return 'Status must be available, sold out, open soon, or hidden.';
    if (imageUrl && String(imageUrl).length > 2000) return 'Product image URL is too long.';
    if (imageUrl) {
        try {
            const imageUrlObject = new URL(imageUrl);
            if (!['http:', 'https:'].includes(imageUrlObject.protocol)) return 'Product image must use http or https.';
            if (imageUrlObject.hostname === 'www.google.com' && imageUrlObject.pathname === '/imgres') return 'Use the direct image URL, not a Google image-results page.';
            if (imageUrlObject.hostname === 'www.facebook.com' || imageUrlObject.hostname === 'facebook.com') return 'Use a direct image URL, not a Facebook page URL.';
        } catch (_) { return 'Product image URL must be valid.'; }
    }
    if (productUrl) { try { if (!['http:', 'https:'].includes(new URL(productUrl).protocol)) return 'Product link must use http or https.'; } catch (error) { return 'Product link must be a valid URL.'; } }
    if (![cardColor, headerColor, buttonColor].every((color) => !color || /^#[0-9a-f]{6}$/i.test(String(color)))) return 'Product colors must be six-digit hex colors.';
    if (!Number.isInteger(Number(investmentDurationDays)) || Number(investmentDurationDays) < 0) return 'Investment duration must be a whole number zero or greater.';
    if (!Number.isFinite(Number(dailyIncomeAmount)) || Number(dailyIncomeAmount) < 0) return 'Daily income amount must be zero or greater.';
    if (!Number.isFinite(Number(dailyIncomePercent)) || Number(dailyIncomePercent) < 0 || Number(dailyIncomePercent) > 100) return 'Daily income percent must be between 0 and 100.';
    if (!Number.isFinite(Number(totalIncome)) || Number(totalIncome) < 0) return 'Total income must be zero or greater.';
    return null;
}

router.delete('/:id', requireAdmin, (req, res) => {
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found.' });
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
        for (const code of COUNTRY_CODES) {
            const config = getCountryConfig(db, code);
            const products = { ...config.products };
            delete products[req.params.id];
            db.prepare("UPDATE country_configs SET products_json = ?, updated_at = datetime('now') WHERE country_code = ?")
                .run(JSON.stringify(products), code);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    logAudit({ adminId: req.user.id, action: 'product_deleted', target: req.params.id, previousValue: existing });
    res.status(204).end();
});

module.exports = { router };
