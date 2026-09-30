const { WebSocketServer, WebSocket } = require('ws');

// Render dynamic port သို့မဟုတ် local port 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // userId -> ws
let quickMatchQueue = []; // [{ userId, language, ws, joinedAt, timeoutTimer }]
const rooms = new Map(); // roomId -> { players: [userId1, userId2] }

const MATCH_TIMEOUT_MS = 30000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE";

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

// ⭐ Gemini AI ထံမှ မေးခွန်းတောင်းယူပေးသည့် Function
async function generateAIQuestion(language) {
    const prompt = `Generate a unique intermediate-level coding challenge for ${language}.
Return ONLY a valid JSON array containing a single object with the exact following structure:
[
  {
    "title": "Short Challenge Title",
    "description": "Clear problem statement with sample input/output format.",
    "starter_code": "Starter code function or setup in ${language}"
  }
]
Do not include markdown blocks like \`\`\`json. Return pure JSON string only.`;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const data = await response.json();
        let jsonText = data.candidates[0].content.parts[0].text.trim();
        jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
        JSON.parse(jsonText); // JSON စစ်ဆေးခြင်း
        return jsonText;
    } catch (error) {
        console.error("AI Question Generation Failed, Fallback used:", error.message);
        return JSON.stringify([{
            "title": `${language.toUpperCase()} Challenge`,
            "description": "Write a function to solve the challenge.",
            "starter_code": "// Write your code here"
        }]);
    }
}

// Render Server မပိတ်စေရန် Ping/Pong Interval
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

    ws.on('message', async (rawData) => { // ⭐ AI Call ရန် async ထည့်သွင်းထားသည်
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

            // 3. Invite Response (Friend Match)
            else if (message.type === 'INVITE_RESPONSE') {
                const senderWs = clients.get(String(message.toUser));

                if (message.action === 'ACCEPT' && senderWs) {
                    const roomId = "FRIEND_ROOM_" + Math.floor(1000 + Math.random() * 9000);
                    const language = message.language || 'java';

                    rooms.set(roomId, { players: [String(message.toUser), registeredUserId] });

                    // ⭐ Gemini AI မေးခွန်းထုတ်ယူခြင်း
                    const questionsPayload = await generateAIQuestion(language);

                    // Host (Invite ပို့သူ) သို့ အကြောင်းကြားမည်
                    sendJson(senderWs, {
                        type: 'START_GAME',
                        roomId: roomId,
                        language: language,
                        opponentId: registeredUserId,
                        questions: questionsPayload
                    });

                    // Guest (Invite လက်ခံသူ) သို့ အကြောင်းကြားမည်
                    sendJson(ws, {
                        type: 'START_GAME',
                        roomId: roomId,
                        language: language,
                        opponentId: String(message.toUser),
                        questions: questionsPayload
                    });

                    console.log(`Friend Match Start: User ${message.toUser} vs User ${registeredUserId} in ${roomId}`);
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
                    rooms.set(roomId, { players: [userId, opponent.userId] });

                    // ⭐ Gemini AI မေးခွန်းထုတ်ယူခြင်း
                    const questionsPayload = await generateAIQuestion(language);

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

            // 6. Real-time Progress
            else if (message.type === 'GAME_PROGRESS') {
                const { roomId, userId, progress } = message;
                const room = rooms.get(roomId);

                if (room) {
                    room.players.forEach(pId => {
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

            // 7. Game Over
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
