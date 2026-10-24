const { db, uuid } = require('../db');

function createNotification({ recipientType, recipientId, type, title, message, relatedType = null, relatedId = null, eventKey = null }) {
    const id = uuid();
    const result = db.prepare(`
        INSERT OR IGNORE INTO notifications
        (id, recipient_type, recipient_id, type, title, message, related_type, related_id, event_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, recipientType, recipientId, type, title, message, relatedType, relatedId, eventKey);
    return result.changes ? db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) : null;
}

function notifyUser(userId, payload) { return createNotification({ ...payload, recipientType: 'user', recipientId: userId }); }

function notifyAdmins(payload) {
    const admins = db.prepare("SELECT id FROM users WHERE role = 'admin' AND status = 'Active'").all();
    return admins.map((admin) => createNotification({ ...payload, recipientType: 'admin', recipientId: admin.id }));
}

function toPublicNotification(row) {
    return { id: row.id, type: row.type, title: row.title, message: row.message, relatedType: row.related_type, relatedId: row.related_id, read: !!row.read_at, createdAt: row.created_at };
}

module.exports = { createNotification, notifyUser, notifyAdmins, toPublicNotification };