const { WebSocketServer, WebSocket } = require('ws');

// Render dynamic port သို့မဟုတ် local port 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // userId -> ws
let quickMatchQueue = []; // [{ userId, language, ws, joinedAt, timeoutTimer }]

// ⭐ အခန်းတစ်ခုစီတွင် မည်သည့် Player များ ရောက်ရှိနေသည်ကို မှတ်သားရန် Map (roomId -> { players: [userId1, userId2] })
const rooms = new Map();

const MATCH_TIMEOUT_MS = 30000;

console.log(`WebSocket Server initialized on port ${PORT}`);

// Helper Function: JSON မက်ဆေ့ချ်များ လုံခြုံစွာ ပို့ရန်
function sendJson(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
            return true;
        } catch (err) {
            console.error("Error sending message:", err.message);
        }
    }
    return false;
}

// Helper Function: Queue ထဲမှ ထုတ်ရန်
function removeFromQueue(userId, targetWs = null) {
    const index = quickMatchQueue.findIndex(p => {
        if (targetWs) {
            return p.userId === userId && p.ws === targetWs;
        }
        return p.userId === userId;
    });

    if (index !== -1) {
        const [player] = quickMatchQueue.splice(index, 1);
        if (player.timeoutTimer) {
            clearTimeout(player.timeoutTimer);
        }
        return player;
    }
    return null;
}

// Render Server အလိုအလျောက် Connection မပိတ်သွားစေရန် Ping/Pong စနစ် (စက္ကန့် ၃၀ တိုင်း စစ်မည်)
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(heartbeatInterval);
});

wss.on('connection', (ws) => {
    let registeredUserId = null;
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (rawData) => {
        try {
            const messageStr = rawData.toString();
            const message = JSON.parse(messageStr);
            console.log("Received:", message);

            // 1. User Register
            if (message.type === 'REGISTER') {
                registeredUserId = String(message.userId);
                clients.set(registeredUserId, ws);
                console.log(`User ${registeredUserId} registered. Total online: ${clients.size}`);
            }

            // 2. Invite Send
            else if (message.type === 'INVITE_SEND') {
                const targetWs = clients.get(String(message.toUser));
                const sent = sendJson(targetWs, {
                    type: 'INVITE_RECEIVED',
                    fromUser: message.fromUser,
                    language: message.language
                });
                if (!sent) {
                    console.log(`User ${message.toUser} is offline or unreachable.`);
                }
            }

            // 3. Invite Response
            else if (message.type === 'INVITE_RESPONSE') {
                const senderWs = clients.get(String(message.toUser));

                if (message.action === 'ACCEPT') {
                    const roomId = "ROOM_" + Math.floor(1000 + Math.random() * 9000);
                    
                    // ⭐ Friend Match အခန်း သိမ်းဆည်းမည်
                    rooms.set(roomId, { players: [String(message.toUser), registeredUserId] });

                    const startGamePayload = {
                        type: 'START_GAME',
                        roomId: roomId,
                        language: message.language || 'java'
                    };

                    sendJson(senderWs, startGamePayload);
                    sendJson(ws, startGamePayload);
                }
            }

            // 4. Quick Match Join
            else if (message.type === 'QUICK_MATCH_JOIN') {
                const userId = String(message.userId);
                const language = String(message.language || 'java').trim().toLowerCase();

                registeredUserId = userId;
                clients.set(userId, ws);

                removeFromQueue(userId);

                const opponentIndex = quickMatchQueue.findIndex(p =>
                    p.language === language &&
                    p.userId !== userId &&
                    p.ws.readyState === WebSocket.OPEN
                );

                if (opponentIndex !== -1) {
                    const [opponent] = quickMatchQueue.splice(opponentIndex, 1);
                    if (opponent.timeoutTimer) {
                        clearTimeout(opponent.timeoutTimer);
                    }

                    const roomId = "QUICK_ROOM_" + Math.floor(1000 + Math.random() * 9000);
                    
                    // ⭐ Quick Match အခန်း သိမ်းဆည်းမည်
                    rooms.set(roomId, { players: [userId, opponent.userId] });

                    const questionsPayload = JSON.stringify([
                        {
                            "title": language.toUpperCase() + " Coding Challenge",
                            "description": "Solve the given problem in real-time.",
                            "starter_code": "// Write code here"
                        }
                    ]);

                    // User A
                    sendJson(ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: language,
                        opponentId: opponent.userId,
                        questions: questionsPayload
                    });

                    // User B
                    sendJson(opponent.ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: language,
                        opponentId: userId,
                        questions: questionsPayload
                    });

                    console.log(`Quick Match Start: User ${userId} vs User ${opponent.userId} in ${roomId}`);
                } else {
                    const timeoutTimer = setTimeout(() => {
                        console.log(`User ${userId} Quick Match timed out.`);
                        removeFromQueue(userId, ws);

                        sendJson(ws, {
                            type: "QUICK_MATCH_TIMEOUT",
                            message: "No active opponent found within time limit."
                        });
                    }, MATCH_TIMEOUT_MS);

                    quickMatchQueue.push({
                        userId,
                        language,
                        ws,
                        joinedAt: Date.now(),
                        timeoutTimer
                    });

                    console.log(`User ${userId} joined Quick Match queue for [${language}]. Queue size: ${quickMatchQueue.length}`);
                }
            }

            // 5. Quick Match Cancel
            else if (message.type === 'QUICK_MATCH_CANCEL') {
                const userId = String(message.userId);
                removeFromQueue(userId, ws);
                console.log(`User ${userId} cancelled Quick Match.`);
            }

            // ⭐ 6. Real-time Progress ကို ပြိုင်ဘက် (Opponent) ဆီ သို့ Broadcast လုပ်ပေးခြင်း
            else if (message.type === 'GAME_PROGRESS') {
                const { roomId, userId, progress } = message;
                const room = rooms.get(roomId);

                if (room) {
                    room.players.forEach(pId => {
                        // မိမိ မဟုတ်သော ပြိုင်ဘက်ဆီသို့သာ Progress ပို့ပေးမည်
                        if (pId !== String(userId)) {
                            const targetWs = clients.get(pId);
                            sendJson(targetWs, {
                                type: 'GAME_PROGRESS',
                                userId: userId,
                                progress: progress
                            });
                        }
                    });
                }
            }

            // ⭐ 7. ပွဲပြီးဆုံးသွားပါက အနိုင်ရသူ အခြေအနေကို နှစ်ဦးလုံးဆီ ပို့ပေးခြင်း
            else if (message.type === 'GAME_OVER') {
                const { roomId, winnerId } = message;
                const room = rooms.get(roomId);

                if (room) {
                    room.players.forEach(pId => {
                        const targetWs = clients.get(pId);
                        sendJson(targetWs, {
                            type: 'GAME_OVER',
                            winnerId: winnerId
                        });
                    });
                    // ပွဲပြီးသွားသဖြင့် Room ကို ဖျက်မည်
                    rooms.delete(roomId);
                    console.log(`Game Over in Room ${roomId}. Winner: ${winnerId}`);
                }
            }

        } catch (err) {
            console.error("JSON Parsing Error:", err.message, "Raw:", rawData.toString());
        }
    });

    ws.on('close', () => {
        if (registeredUserId) {
            if (clients.get(registeredUserId) === ws) {
                clients.delete(registeredUserId);
            }
            removeFromQueue(registeredUserId, ws);
            console.log(`User ${registeredUserId} disconnected.`);
        }
    });

    ws.on('error', (err) => {
        console.error(`Socket error for User ${registeredUserId}:`, err.message);
    });
});
