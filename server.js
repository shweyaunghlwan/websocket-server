const { WebSocketServer } = require('ws');

// Render မှ ပေးမည့် Dynamic Port ကို ယူမည် (Local တွင် 8080 သုံးမည်)
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map();

// Quick Match စောင့်ဆိုင်းသူများ စာရင်း [{ userId, language, ws, joinedAt, timeoutTimer }]
let quickMatchQueue = [];

// စောင့်ဆိုင်းချိန် သတ်မှတ်ချက် (စက္ကန့် ၃၀)
const MATCH_TIMEOUT_MS = 30000;

console.log(`WebSocket Server is running on port ${PORT}`);

// Helper Function: 特定 Connection (targetWs) ၏ Queue Item ကိုသာ စစ်ဆေး၍ ဖျက်ဆီးခြင်း
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
            clearTimeout(player.timeoutTimer); // Timer ကို စနစ်တကျ ရပ်ပါ
        }
        return player;
    }
    return null;
}

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
                if (targetWs && targetWs.readyState === 1) {
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

                    if (senderWs && senderWs.readyState === 1) senderWs.send(startGamePayload);
                    if (ws.readyState === 1) ws.send(startGamePayload);
                }
            }

            // 4. Quick Match Join (FIFO Queue + Timeout Management)
            else if (message.type === 'QUICK_MATCH_JOIN') {
                const userId = String(message.userId);
                const language = String(message.language || 'java').trim().toLowerCase();

                registeredUserId = userId;
                clients.set(userId, ws);

                // Queue ထဲမှ မိမိ Connection အဟောင်းရှိပါက အရင်ရှင်းထုတ်ပါ
                removeFromQueue(userId);

                // FIFO အလိုက် အစောဆုံး ရောက်နေသော Matching Opponent ကို ရှာပါ
                const opponentIndex = quickMatchQueue.findIndex(p =>
                    p.language === language && p.userId !== userId && p.ws.readyState === 1
                );

                if (opponentIndex !== -1) {
                    // Match တွေ့ပါက Queue ထဲမှ ထုတ်ပြီး Timeout Timer ကို ရပ်ဆိုင်းပါ
                    const [opponent] = quickMatchQueue.splice(opponentIndex, 1);
                    if (opponent.timeoutTimer) {
                        clearTimeout(opponent.timeoutTimer);
                    }

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
                    if (ws.readyState === 1) ws.send(matchData);
                    if (opponent.ws.readyState === 1) opponent.ws.send(matchData);

                    console.log(`Quick Match Found: ${userId} vs ${opponent.userId}`);
                } else {
                    // Match မတွေ့သေးပါက စက္ကန့် ၃၀ ပြည့်လျှင် အလိုအလျောက် ပယ်ဖျက်မည့် Timer စတင်ပါ
                    const timeoutTimer = setTimeout(() => {
                        console.log(`User ${userId} Quick Match timed out.`);
                        removeFromQueue(userId, ws);

                        if (ws.readyState === 1) {
                            ws.send(JSON.stringify({
                                type: "QUICK_MATCH_TIMEOUT",
                                message: "No active opponent found within time limit."
                            }));
                        }
                    }, MATCH_TIMEOUT_MS);

                    // Queue ထဲသို့ Timestamp နှင့် Timer ID ပါဝင်အောင် ထည့်ထားပါ
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
        } catch (err) {
            console.error("Invalid JSON:", err.message);
        }
    });

    ws.on('close', () => {
        if (registeredUserId) {
            // လိုင်းကျသွားသော သီးသန့် Connection (ws) ကိုသာ Queue ထဲမှ ဖျက်မည်
            clients.delete(registeredUserId);
            removeFromQueue(registeredUserId, ws);
            console.log(`User ${registeredUserId} disconnected.`);
        }
    });
});
