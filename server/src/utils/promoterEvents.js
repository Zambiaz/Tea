const clients = new Set();

function addClient(response) {
    clients.add(response);
    response.on('close', () => clients.delete(response));
}

function publish(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const response of clients) {
        try { response.write(payload); } catch (error) { clients.delete(response); }
    }
}

module.exports = { addClient, publish };
