const crypto = require('crypto');

const sensitiveKey = /password|token|secret|hash|authorization/i;

function redact(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? '[redacted]' : redact(entry),
    ]));
}

async function logAudit(client, {
    adminId,
    action,
    target,
    amount,
    previousValue,
    newValue,
    status = 'success',
    reason,
}) {
    await client.query(
        `INSERT INTO audit_logs
         (id, admin_id, action, target, amount, previous_value, new_value, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            crypto.randomUUID(),
            adminId || null,
            action,
            target || null,
            amount === undefined || amount === null ? null : Number(amount),
            previousValue === undefined ? null : JSON.stringify(redact(previousValue)),
            newValue === undefined ? null : JSON.stringify(redact(newValue)),
            status,
            reason || null,
        ],
    );
}

module.exports = { logAudit, redact };
