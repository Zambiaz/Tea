const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => Number.isFinite(Number(value));
const nonNegative = (value) => finite(value) && Number(value) >= 0;
const whole = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const wholeMoney = (value) => Math.max(0, Math.round(Number(value) || 0));

function validateSetting(key, value) {
    if (!isObject(value) && !Array.isArray(value)) return { error: `${key} settings must be an object.` };
    if (key === 'welcomeBonus') {
        if (!isObject(value) || typeof value.enabled !== 'boolean' || !['fixed', 'percentage'].includes(value.type) ||
            !nonNegative(value.amount) || (value.type === 'percentage' && Number(value.amount) > 100) ||
            !whole(value.minimumDeposit) || !nonNegative(value.expiryDays) ||
            (value.depositRequired !== undefined && typeof value.depositRequired !== 'boolean') ||
            (value.productPurchaseRequired !== undefined && typeof value.productPurchaseRequired !== 'boolean') ||
            (value.withdrawable !== undefined && typeof value.withdrawable !== 'boolean')) return { error: 'Invalid Welcome Bonus settings.' };
        return { value: { ...value, amount: value.type === 'fixed' ? wholeMoney(value.amount) : Number(value.amount), minimumDeposit: wholeMoney(value.minimumDeposit) } };
    }
    if (key === 'deposit') {
        if (!isObject(value)) return { error: 'Invalid deposit settings.' };
        if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return { error: 'Deposit enabled must be true or false.' };
        if (value.proofRequired !== undefined && typeof value.proofRequired !== 'boolean') return { error: 'Deposit proof requirement must be true or false.' };
        const next = { ...value };
        for (const method of ['mtn', 'airtel']) {
            if (value[method] === undefined) continue;
            const config = value[method];
            if (!isObject(config) || (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
                !whole(config.min ?? 0) || !whole(config.max ?? Number.MAX_SAFE_INTEGER) ||
                Number(config.max ?? Number.MAX_SAFE_INTEGER) < Number(config.min ?? 0)) return { error: `Invalid ${method.toUpperCase()} deposit settings.` };
            next[method] = { ...config, min: wholeMoney(config.min), max: wholeMoney(config.max) };
        }
        if (value.minimumAmount !== undefined && !whole(value.minimumAmount)) return { error: 'Minimum deposit must be a non-negative whole amount.' };
        if (value.maximumAmount !== undefined && (!whole(value.maximumAmount) || Number(value.maximumAmount) < Number(value.minimumAmount || 0))) return { error: 'Maximum deposit must be at least the minimum.' };
        return { value: next };
    }
    if (key === 'withdraw') {
        if (!isObject(value)) return { error: 'Invalid withdrawal settings.' };
        const next = { ...value };
        for (const field of ['enabled', 'accountHolderNameRequired']) {
            if (value[field] !== undefined && typeof value[field] !== 'boolean') return { error: 'Withdrawal settings are invalid.' };
        }
        for (const field of ['minAmount', 'maxAmount', 'minimumBalance']) {
            if (value[field] !== undefined && !whole(value[field])) return { error: 'Withdrawal limits must be non-negative whole amounts.' };
        }
        const minAmount = Number(value.minAmount ?? value.mtn?.min ?? value.airtel?.min ?? 0);
        const maxAmount = Number(value.maxAmount ?? value.mtn?.max ?? value.airtel?.max ?? Number.MAX_SAFE_INTEGER);
        if (maxAmount < minAmount) return { error: 'Withdrawal maximum must be at least the minimum.' };
        if (value.feePercent !== undefined && (!finite(value.feePercent) || Number(value.feePercent) < 0 || Number(value.feePercent) > 100)) return { error: 'Withdrawal fee percentage is invalid.' };
        for (const method of ['mtn', 'airtel', 'bank']) {
            if (value[method] === undefined) continue;
            const config = value[method];
            if (!isObject(config) || (config.enabled !== undefined && typeof config.enabled !== 'boolean') ||
                (config.min !== undefined && !whole(config.min)) || (config.max !== undefined && !whole(config.max)) ||
                Number(config.max ?? Number.MAX_SAFE_INTEGER) < Number(config.min ?? 0)) return { error: `Invalid ${method.toUpperCase()} withdrawal settings.` };
            next[method] = { ...config, min: wholeMoney(config.min), max: wholeMoney(config.max) };
        }
        if (value.availability !== undefined) {
            const schedule = value.availability;
            const weekdays = new Set(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
            if (!isObject(schedule) || typeof schedule.enabled !== 'boolean' || !Array.isArray(schedule.days) ||
                schedule.days.some((day) => !weekdays.has(day)) ||
                !Number.isInteger(Number(schedule.openHour ?? 0)) || Number(schedule.openHour ?? 0) < 0 || Number(schedule.openHour ?? 0) > 23 ||
                !Number.isInteger(Number(schedule.closeHour ?? 24)) || Number(schedule.closeHour ?? 24) < 0 || Number(schedule.closeHour ?? 24) > 24) return { error: 'Invalid withdrawal availability schedule.' };
            if (schedule.timeZone) {
                try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }); } catch (_) { return { error: 'Invalid withdrawal time zone.' }; }
            }
            next.availability = { ...schedule, openHour: Number(schedule.openHour ?? 0), closeHour: Number(schedule.closeHour ?? 24) };
        }
        return { value: { ...next, feePercent: Number(value.feePercent ?? 0), minAmount: wholeMoney(minAmount), maxAmount: wholeMoney(maxAmount), minimumBalance: wholeMoney(value.minimumBalance ?? 0) } };
    }
    if (key === 'investment') {
        if (!isObject(value) || !whole(value.minimumAmount) || !whole(value.maximumAmount) ||
            !nonNegative(value.durationDays) || !nonNegative(value.dailyRatePercent) || Number(value.dailyRatePercent) > 100 ||
            Number(value.maximumAmount) < Number(value.minimumAmount) ||
            (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
            (value.availableAmounts !== undefined && (!Array.isArray(value.availableAmounts) || value.availableAmounts.length > 100 || value.availableAmounts.some((amount) => !whole(amount))))) return { error: 'Investment prices, limits, and duration are invalid.' };
        return { value: { ...value, minimumAmount: wholeMoney(value.minimumAmount), maximumAmount: wholeMoney(value.maximumAmount) } };
    }
    if (key === 'chakin') {
        if (!isObject(value) || typeof value.enabled !== 'boolean' || !whole(value.reward) ||
            !nonNegative(value.cooldownHours) || !nonNegative(value.maxCheckins) ||
            (value.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate)) ||
            (value.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(value.endDate)) ||
            (value.startDate && value.endDate && value.endDate < value.startDate)) return { error: 'Invalid Chakin settings.' };
        return { value: { ...value, reward: wholeMoney(value.reward), cooldownHours: Number(value.cooldownHours), maxCheckins: Math.floor(Number(value.maxCheckins)) } };
    }
    if (key === 'giftcode' && (!isObject(value) || typeof value.enabled !== 'boolean')) return { error: 'Invalid Gift Code settings.' };
    if (key === 'commissions' && (!Array.isArray(value) || value.length > 10 || value.some((item) => !isObject(item) || !Number.isInteger(Number(item.level)) || Number(item.level) < 1 || !finite(item.percent) || Number(item.percent) < 0 || Number(item.percent) > 100))) return { error: 'Commission settings are invalid.' };
    if (key === 'inviteRewards' && (!Array.isArray(value) || value.length > 100 || value.some((item) => !isObject(item) || !whole(item.requiredInvites) || !whole(item.reward)))) return { error: 'Invite reward settings are invalid.' };
    if (key === 'coffeePlanet') {
        const validText = (text, limit) => typeof text === 'string' && text.length <= limit;
        const validImage = (source) => {
            if (typeof source !== 'string') return false;
            if (/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source)) return source.length <= 420000;
            if (source.length > 2048) return false;
            if (/^\/assets\/coffee-slides\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/i.test(source)) return true;
            try { return new URL(source).protocol === 'https:'; } catch (_) { return false; }
        };
        if (!isObject(value) || !validText(value.title, 100) || !validText(value.subtitle, 160) ||
            !validText(value.aboutTitle, 100) || !validText(value.aboutText, 3000) ||
            !Array.isArray(value.images) || value.images.length > 5 ||
            value.images.some((image) => !image || !validImage(image.src) || !validText(image.caption || '', 120))) {
            return { error: 'Invalid home page settings. Use up to 5 HTTPS image URLs, bundled coffee photos or small uploaded photos.' };
        }
    }
    return { value };
}

module.exports = { validateSetting };
