const crypto = require('crypto');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

function generateReferralCode() {
    const characters = [
        ...Array.from({ length: 3 }, () => LETTERS[crypto.randomInt(LETTERS.length)]),
        ...Array.from({ length: 3 }, () => DIGITS[crypto.randomInt(DIGITS.length)]),
    ];

    for (let index = characters.length - 1; index > 0; index -= 1) {
        const swapIndex = crypto.randomInt(index + 1);
        [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
    }

    return `${characters.slice(0, 3).join('')}-${characters.slice(3).join('')}`;
}

function isReferralCodeFormat(code) {
    return typeof code === 'string'
        && /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(code)
        && (code.match(/[A-Z]/g) || []).length === 3
        && (code.match(/[0-9]/g) || []).length === 3;
}

module.exports = { generateReferralCode, isReferralCodeFormat };