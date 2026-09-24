const { WebSocketServer } = require('ws');

// Render မှ ပေးမည့် Dynamic Port ကို ယူမည် (Local တွင် 8080 သုံးမည်)
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const clients = new Map();

console.log(`WebSocket Server is running on port ${PORT}`);

wss.on('connection', (ws) => {
    let registeredUserId = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log("Received:", message);

            // 1. User Register
            if (message.type === 'REGISTER') {
                registeredUserId = String(message.userId);
                clients.set(registeredUserId, ws);
                console.log(`User ${registeredUserId} connected. Total online: ${clients.size}`);
            }
            // 2. Invite Send (Player A -> Player B)
            else if (message.type === 'INVITE_SEND') {
                const targetWs = clients.get(String(message.toUser));
                if (targetWs) {
                    targetWs.send(JSON.stringify({
                        type: 'INVITE_RECEIVED',
                        fromUser: message.fromUser,
                        language: message.language
                    }));
                } else {
                    console.log(`User ${message.toUser} is offline.`);
                }
            }
            // 3. Invite Response (Player B -> Player A)
            else if (message.type === 'INVITE_RESPONSE') {
                const senderWs = clients.get(String(message.toUser));

                if (message.action === 'ACCEPT') {
                    const roomId = "ROOM_" + Math.floor(Math.random() * 10000);

                    const startGamePayload = JSON.stringify({
                        type: 'START_GAME',
                        roomId: roomId,
                        language: 'java'
                    });

                    if (senderWs) senderWs.send(startGamePayload);
                    ws.send(startGamePayload);
                }
            }
        } catch (err) {
            console.error("Invalid JSON:", err.message);
        }
    });

    ws.on('close', () => {
        if (registeredUserId) {
            clients.delete(registeredUserId);
            console.log(`User ${registeredUserId} disconnected.`);
        }
    });
});