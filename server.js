// server.js - Simple local WebSocket signaling server for Chrome LAN Share
// Run with: node server.js
// This provides automated signaling over LAN via WebSocket.

const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

let clients = [];

console.log('Signaling server running on ws://localhost:8080');

wss.on('connection', (ws) => {
    console.log('New client connected');
    clients.push(ws);

    ws.on('message', (message) => {
        const data = JSON.parse(message.toString());
        console.log('Received:', data.type);

        // Broadcast to all other clients
        clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        clients = clients.filter(client => client !== ws);
    });
});