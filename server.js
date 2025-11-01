// server.js - Simple local WebSocket signaling server for Chrome LAN Share
// Run with: node server.js
// This provides automated signaling over LAN via WebSocket.


const WebSocket = require('ws');
const os = require('os');

const wss = new WebSocket.Server({ host: '0.0.0.0', port: 8080 });

const clients = new Map(); // ws -> { id, address }
let nextClientId = 1;

function printLANAddresses(port) {
    const nets = os.networkInterfaces();
    let found = false;
    console.log('Signaling server running on:');
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Only show IPv4, non-internal
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  ws://${net.address}:${port}`);
                found = true;
            }
        }
    }
    if (!found) {
        console.log('  ws://localhost:' + port);
    }
    console.log('(Use one of these addresses on your other device)');
}

printLANAddresses(8080);

wss.on('connection', (ws) => {
    const clientId = `client-${nextClientId++}`;
    const address = ws._socket?.remoteAddress || 'unknown';
    const port = ws._socket?.remotePort || 'unknown';
    const clientKey = `${address}:${port}`;
    clients.set(ws, { id: clientId, address, port, key: clientKey });

    console.log(`[${clientId}] connected from ${address}:${port}. Active clients: ${clients.size}`);

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.warn(`[${clientId}] (${address}:${port}) sent invalid JSON: ${err.message}`);
            return;
        }

        console.log(
            `[${clientId}] (${address}:${port}) -> ${data.type || 'unknown'} message. Relaying to peers...`
        );

        // Broadcast to all other clients
        for (const [client, info] of clients.entries()) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
                console.log(`  relayed to ${info.id} (${info.address}:${info.port})`);
            }
        }
    });

    ws.on('close', (code, reason) => {
        clients.delete(ws);
        const textReason = reason && reason.toString() ? ` (${reason.toString()})` : '';
        console.log(`[${clientId}] disconnected ${address}:${port} with code ${code}${textReason}. Active clients: ${clients.size}`);
    });

    ws.on('error', (err) => {
        console.error(`[${clientId}] error from ${address}:${port}:`, err.message);
    });
});