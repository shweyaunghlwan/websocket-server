const { WebSocketServer } = require('ws');

// Render မှ ပေးမည့် Dynamic Port ကို ယူမည် (Local တွင် 8080 သုံးမည်)
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map();

// Quick Match စောင့်ဆိုင်းသူများ စာရင်း [{ userId, language, ws }]
let quickMatchQueue = [];

console.log(`WebSocket Server is running on port ${PORT}`);

wss.on('connection', (ws) => {
    let registeredUserId = null;

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            console.log("Received:", message);

            // 1. User Register (Friend Match)
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
                        language: message.language || 'java'
                    });

                    if (senderWs) senderWs.send(startGamePayload);
                    ws.send(startGamePayload);
                }
            }
            // 4. Quick Match Join
            else if (message.type === 'QUICK_MATCH_JOIN') {
                const userId = String(message.userId);
                const language = message.language || 'java';
                registeredUserId = userId;
                clients.set(userId, ws);

                // Queue ထဲမှ အဟောင်းရှိလျှင် ဖျက်ပါ
                quickMatchQueue = quickMatchQueue.filter(p => p.userId !== userId);

                // တူညီသော Language ဖြင့် စောင့်နေသည့် တခြား Player ရှိမရှိ ရှာပါ
                const opponentIndex = quickMatchQueue.findIndex(p => p.language === language && p.userId !== userId);

                if (opponentIndex !== -1) {
                    // Match တွေ့ပါက Queue ထဲမှ စောင့်နေသူကို ထုတ်ပါ
                    const opponent = quickMatchQueue.splice(opponentIndex, 1)[0];
                    const roomId = "QUICK_ROOM_" + Math.floor(Math.random() * 10000);

                    // Challenge Question Payload
                    const questionsPayload = JSON.stringify([
                        {
                            "title": language.toUpperCase() + " Coding Challenge",
                            "description": "Solve the given problem in real-time.",
                            "starter_code": "// Write code here"
                        }
                    ]);

                    const matchData = JSON.stringify({
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: language,
                        questions: questionsPayload
                    });

                    // Player (၂) ယောက်လုံးထံ ပြိုင်တူ ပို့ပေးပါ
                    ws.send(matchData);
                    if (opponent.ws.readyState === 1) { // 1 = OPEN
                        opponent.ws.send(matchData);
                    }

                    console.log(`Quick Match Found: ${userId} vs ${opponent.userId}`);
                } else {
                    // မတွေ့သေးပါက Queue ထဲ ထည့်ထားပါ
                    quickMatchQueue.push({ userId, language, ws });
                    console.log(`User ${userId} joined Quick Match queue for ${language}`);
                }
            }
            // 5. Quick Match Cancel
            else if (message.type === 'QUICK_MATCH_CANCEL') {
                const userId = String(message.userId);
                quickMatchQueue = quickMatchQueue.filter(p => p.userId !== userId);
                console.log(`User ${userId} cancelled Quick Match.`);
            }
        } catch (err) {
            console.error("Invalid JSON:", err.message);
        }
    });

    ws.on('close', () => {
        if (registeredUserId) {
            clients.delete(registeredUserId);
            quickMatchQueue = quickMatchQueue.filter(p => p.userId !== registeredUserId);
            console.log(`User ${registeredUserId} disconnected.`);
        }
    });
});
