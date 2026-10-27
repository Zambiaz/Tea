async function publish(client, eventType, payload) {
    await client.query(
        'INSERT INTO promoter_events (event_type, payload) VALUES ($1, $2)',
        [eventType, JSON.stringify(payload)],
    );
}

module.exports = { publish };
