// Every sensitive admin action should call this so there is always a traceable record.
const { db, uuid } = require('../db');

const SENSITIVE_KEY = /password|token|secret|hash|authorization/i;

function redact(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(entry)]));
}

function logAudit({ adminId, action, target, amount, previousValue, newValue, status = 'success', reason }) {
    db.prepare(
        'INSERT INTO audit_logs (id, admin_id, action, target, amount, previous_value, new_value, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
        uuid(),
        adminId || null,
        action,
        target || null,
        amount === undefined || amount === null ? null : Number(amount),
        previousValue !== undefined ? JSON.stringify(redact(previousValue)) : null,
        newValue !== undefined ? JSON.stringify(redact(newValue)) : null,
        status,
        reason || null,
    );
}

module.exports = { logAudit };
