const { uuid } = require('./store');

function toPublicNotification(row) {
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        message: row.message,
        relatedType: row.related_type,
        relatedId: row.related_id,
        read: Boolean(row.read_at),
        createdAt: row.created_at,
    };
}

async function createNotification(client, {
    recipientType,
    recipientId,
    type,
    title,
    message,
    relatedType = null,
    relatedId = null,
    eventKey = null,
}) {
    await client.query(
        `INSERT INTO notifications
         (id, recipient_type, recipient_id, type, title, message, related_type, related_id, event_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (event_key) DO NOTHING`,
        [uuid(), recipientType, recipientId, type, title, message, relatedType, relatedId, eventKey],
    );
}

async function notifyAdmins(client, payload) {
    const { rows } = await client.query("SELECT id FROM users WHERE role = 'admin' AND status = 'Active'");
    for (const admin of rows) {
        await createNotification(client, {
            ...payload,
            recipientType: 'admin',
            recipientId: admin.id,
            eventKey: payload.eventKey ? `${payload.eventKey}:admin:${admin.id}` : null,
        });
    }
}

module.exports = { createNotification, notifyAdmins, toPublicNotification };
