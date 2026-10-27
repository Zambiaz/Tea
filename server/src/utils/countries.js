const COUNTRIES = Object.freeze({
    RW: Object.freeze({ code: 'RW', name: 'Rwanda', currency: 'RWF', flag: '🇷🇼', flagImage: '/assets/flags/rw.svg', dialCode: '+250', timeZone: 'Africa/Kigali' }),
    UG: Object.freeze({ code: 'UG', name: 'Uganda', currency: 'UGX', flag: '🇺🇬', flagImage: '/assets/flags/ug.svg', dialCode: '+256', timeZone: 'Africa/Kampala' }),
    ZM: Object.freeze({ code: 'ZM', name: 'Zambia', currency: 'ZMW', flag: '🇿🇲', flagImage: '/assets/flags/zm.svg', dialCode: '+260', timeZone: 'Africa/Lusaka' }),
    BI: Object.freeze({ code: 'BI', name: 'Burundi', currency: 'BIF', flag: '🇧🇮', flagImage: '/assets/flags/bi.svg', dialCode: '+257', timeZone: 'Africa/Bujumbura' }),
    CD: Object.freeze({ code: 'CD', name: 'DR Congo', currency: 'CDF', flag: '🇨🇩', flagImage: '/assets/flags/cd.svg', dialCode: '+243', timeZone: 'Africa/Kinshasa' }),
    KE: Object.freeze({ code: 'KE', name: 'Kenya', currency: 'KES', flag: '🇰🇪', flagImage: '/assets/flags/ke.svg', dialCode: '+254', timeZone: 'Africa/Nairobi' }),
    SO: Object.freeze({ code: 'SO', name: 'Somalia', currency: 'SOS', flag: '🇸🇴', flagImage: '/assets/flags/so.svg', dialCode: '+252', timeZone: 'Africa/Mogadishu' }),
    SS: Object.freeze({ code: 'SS', name: 'South Sudan', currency: 'SSP', flag: '🇸🇸', flagImage: '/assets/flags/ss.svg', dialCode: '+211', timeZone: 'Africa/Juba' }),
    TZ: Object.freeze({ code: 'TZ', name: 'Tanzania', currency: 'TZS', flag: '🇹🇿', flagImage: '/assets/flags/tz.svg', dialCode: '+255', timeZone: 'Africa/Dar_es_Salaam' }),
});

const COUNTRY_CODES = Object.freeze(Object.keys(COUNTRIES));
const COUNTRY_SETTING_KEYS = Object.freeze([
    'deposit',
    'withdraw',
    'investment',
    'welcomeBonus',
    'chakin',
    'giftcode',
    'commissions',
    'inviteRewards',
]);

function getCountry(code) {
    return COUNTRIES[String(code || '').trim().toUpperCase()] || null;
}

function isValidCountryPhone(code, phone) {
    const countryCode = String(code || '').toUpperCase();
    const value = String(phone || '').replace(/[\s()-]/g, '');
    const digits = value.replace(/^\+/, '');
    const callingCode = COUNTRIES[countryCode]?.dialCode.slice(1);
    const nationalNumber = callingCode && digits.startsWith(callingCode)
        ? digits.slice(callingCode.length)
        : digits;
    return isValidNationalPhone(countryCode, nationalNumber);
}

function isValidNationalPhone(code, phone) {
    const value = String(phone || '');
    const patterns = {
        RW: /^0?7\d{8}$/,
        UG: /^0?7\d{8}$/,
        ZM: /^0?9\d{8}$/,
        BI: /^[267]\d{7}$/,
        CD: /^0?[89]\d{8}$/,
        KE: /^0?[17]\d{8}$/,
        SO: /^0?[679]\d{8}$/,
        SS: /^0?[79]\d{8}$/,
        TZ: /^0?[6789]\d{8}$/,
    };
    return patterns[String(code || '').toUpperCase()]?.test(value) || false;
}

function normalizeNationalPhone(code, phone) {
    const countryCode = String(code || '').toUpperCase();
    const value = String(phone || '');
    if (!isValidNationalPhone(countryCode, value)) return null;
    if (countryCode !== 'BI') {
        return value.startsWith('0') ? value : `0${value}`;
    }
    return value;
}

function getNationalPhoneCandidates(code, phone) {
    const normalized = normalizeNationalPhone(code, phone);
    if (!normalized) return [];
    const candidates = [normalized];
    const country = COUNTRIES[String(code || '').toUpperCase()];
    const internationalNationalNumber = country?.code !== 'BI'
        ? normalized.slice(1)
        : normalized;
    if (country) {
        const callingCode = country.dialCode.slice(1);
        candidates.push(internationalNationalNumber, `${callingCode}${internationalNationalNumber}`, `+${callingCode}${internationalNationalNumber}`);
    }
    return [...new Set(candidates)];
}

function getCountryConfig(db, code) {
    const country = getCountry(code);
    if (!country) return null;
    const row = db.prepare('SELECT enabled, settings_json, products_json FROM country_configs WHERE country_code = ?').get(country.code);
    if (!row) return { ...country, enabled: false, settings: {}, products: {} };
    return {
        ...country,
        enabled: Boolean(row.enabled),
        settings: JSON.parse(row.settings_json),
        products: JSON.parse(row.products_json),
    };
}

function getCountrySetting(db, code, key) {
    const countryConfig = getCountryConfig(db, code);
    if (!countryConfig || !Object.hasOwn(countryConfig.settings, key)) {
        const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value_json) : null;
    }
    return countryConfig.settings[key];
}

function getCountryProduct(db, code, product) {
    const countryConfig = getCountryConfig(db, code);
    const override = countryConfig?.products?.[product.id];
    return override ? { ...product, ...override } : product;
}

module.exports = { COUNTRIES, COUNTRY_CODES, COUNTRY_SETTING_KEYS, getCountry, getCountryConfig, getCountrySetting, getCountryProduct, isValidCountryPhone, isValidNationalPhone, normalizeNationalPhone, getNationalPhoneCandidates };
