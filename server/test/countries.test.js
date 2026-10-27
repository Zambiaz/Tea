const test = require('node:test');
const assert = require('node:assert/strict');
const {
    COUNTRIES,
    getCountry,
    getNationalPhoneCandidates,
    isValidCountryPhone,
    normalizeNationalPhone,
} = require('../src/utils/countries');

test('country catalog includes East African Community countries and preserves existing options', () => {
    const eastAfricanCommunity = ['BI', 'CD', 'KE', 'RW', 'SO', 'SS', 'TZ', 'UG'];
    for (const code of eastAfricanCommunity) {
        assert.ok(COUNTRIES[code], `Missing EAC country ${code}`);
        assert.ok(getCountry(code).currency);
        assert.ok(getCountry(code).dialCode);
        assert.ok(getCountry(code).timeZone);
    }
    assert.equal(getCountry('ZM').currency, 'ZMW');
});

test('new country phone formats validate and normalize for registration and withdrawal accounts', () => {
    const examples = {
        CD: '0812345678',
        KE: '0712345678',
        SO: '0612345678',
        SS: '0912345678',
        TZ: '0712345678',
    };

    for (const [code, phone] of Object.entries(examples)) {
        assert.equal(isValidCountryPhone(code, phone), true, `${code} should accept ${phone}`);
        assert.equal(isValidCountryPhone(code, `+${COUNTRIES[code].dialCode.slice(1)}${phone.slice(1)}`), true);
    }
    assert.equal(normalizeNationalPhone('KE', '712345678'), '0712345678');
    assert.ok(getNationalPhoneCandidates('KE', '712345678').includes('+254712345678'));
    assert.equal(isValidCountryPhone('KE', '12345'), false);
});
