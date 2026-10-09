const { WebSocketServer, WebSocket } = require('ws');

// Render dynamic port သို့မဟုတ် local port 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // userId -> ws
let quickMatchQueue = []; // [{ userId, language, ws, joinedAt, timeoutTimer }]
const rooms = new Map(); // roomId -> { players: [userId1, userId2] }

const MATCH_TIMEOUT_MS = 30000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PYTHONANYWHERE_URL = "https://NickayJohn26.pythonanywhere.com";

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

// Helper Function: Language Key အမည်များ ပုံမှန်ဖြစ်စေရန် (Language Normalization)
function normalizeLanguage(lang) {
    if (!lang) return 'java';
    const l = String(lang).toLowerCase().trim();
    if (l === 'c++' || l === 'cpp') return 'cpp';
    if (l === 'python' || l === 'py') return 'python';
    if (l === 'javascript' || l === 'js') return 'javascript';
    return l;
}

// ⭐ Sololearn Style Static Fallback Questions (Code Snippets & Output Predictions)
const FALLBACK_QUESTIONS = {
    java: [
        { type: "mcq", title: "Output Prediction", code_snippet: "int x = 5;\nSystem.out.println(x++ + ++x);", description: "What will be printed?", options: ["11", "12", "10", "Compilation Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Array Index", code_snippet: "int[] a = {1, 2, 3};\nSystem.out.println(a[3]);", description: "What is the result of running this code?", options: ["3", "0", "ArrayIndexOutOfBoundsException", "Compilation Error"], correct_answer: 2, time_limit: 15 },
        { type: "mcq", title: "String Equality", code_snippet: "String a = \"Java\";\nString b = new String(\"Java\");\nSystem.out.println(a == b);", description: "What is the output?", options: ["true", "false", "null", "Compilation Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Loop Execution", code_snippet: "int count = 0;\nfor(int i=0; i<5; i+=2) count++;\nSystem.out.println(count);", description: "What will count be?", options: ["2", "3", "5", "1"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Ternary Operator", code_snippet: "int x = 10;\nint y = (x > 5) ? (x < 15 ? 1 : 2) : 3;\nSystem.out.println(y);", description: "What is the output?", options: ["1", "2", "3", "10"], correct_answer: 0, time_limit: 15 }
    ],
    cpp: [
        { type: "mcq", title: "C++ Pointer Output", code_snippet: "int a = 10;\nint *p = &a;\n*p = 20;\ncout << a;", description: "What is the output?", options: ["10", "20", "Garbage value", "Compilation Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Vector Size", code_snippet: "vector<int> v = {1, 2, 3};\nv.pop_back();\ncout << v.size();", description: "What is the size of vector v?", options: ["3", "2", "1", "0"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Increment", code_snippet: "int x = 3;\ncout << x++ * 2;", description: "What will be printed?", options: ["6", "8", "7", "4"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "C++ Reference", code_snippet: "int a = 5;\nint &r = a;\nr = 10;\ncout << a;", description: "What will be printed?", options: ["5", "10", "Error", "Address of a"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Default Values", code_snippet: "bool flag;\ncout << flag;", description: "What is the output or behavior?", options: ["true", "false", "Undefined / Uninitialized", "1"], correct_answer: 2, time_limit: 15 }
    ],
    python: [
        { type: "mcq", title: "Python List Slicing", code_snippet: "nums = [10, 20, 30, 40, 50]\nprint(nums[1:4])", description: "What will be printed?", options: ["[20, 30, 40]", "[10, 20, 30]", "[20, 30]", "[30, 40, 50]"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "Python Dict Get", code_snippet: "d = {'a': 1, 'b': 2}\nprint(d.get('c', 3))", description: "What is the output?", options: ["None", "KeyError", "3", "c"], correct_answer: 2, time_limit: 15 },
        { type: "mcq", title: "Python String Multiply", code_snippet: "print('2' * 3)", description: "What is the output?", options: ["6", "222", "Error", "23"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python Boolean Evaluation", code_snippet: "print(bool([]) or bool('False'))", description: "What will be printed?", options: ["True", "False", "None", "Error"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "Python Lambda", code_snippet: "f = lambda x, y: x if x > y else y\nprint(f(7, 4))", description: "What is the output?", options: ["7", "4", "True", "SyntaxError"], correct_answer: 0, time_limit: 15 }
    ]
};

function getRandomFallback(language) {
    const langKey = normalizeLanguage(language);
    const list = FALLBACK_QUESTIONS[langKey] || FALLBACK_QUESTIONS['java'];
    return JSON.stringify(list);
}

// ⭐ PythonAnywhere API မှ မေးခွန်း လှမ်းတောင်းသည့် Function
async function fetchFromPythonAnywhere(language, difficulty = "easy") {
    try {
        const url = `${PYTHONANYWHERE_URL}/api/get-question?language=${encodeURIComponent(language)}&difficulty=${encodeURIComponent(difficulty)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const data = await res.text();
            JSON.parse(data);
            return data;
        }
    } catch (e) {
        console.warn("PythonAnywhere API Fetch Failed:", e.message);
    }
    return null;
}

// ⭐ Sololearn-style Fast 5 MCQ/Code Output Questions AI Generator (Gemini 2.0 Engine)
async function generateAIQuestion(language) {
    const targetLang = normalizeLanguage(language);
    const randomSeed = Math.floor(Math.random() * 100000);

    const prompt = `Generate a JSON array of exactly 5 Sololearn-style fast-paced coding challenge questions for ${targetLang}.
Seed: ${randomSeed}.

Goal: Test quick code output prediction, syntax awareness, logic, and debugging in a 1v1 challenge.

Rules:
- Generate 5 Multiple Choice Questions (type: "mcq").
- Focus heavily on "What is the output of this code snippet?" or "Fill in the blank/syntax logic".
- Provide a short, realistic code snippet for each question in "code_snippet".

Exact JSON Format required:
[
  {
    "type": "mcq",
    "title": "Short Question Title (e.g., Output Prediction)",
    "code_snippet": "short code snippet in ${targetLang}",
    "description": "Clear question (e.g. What will be printed?)",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 0,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${targetLang}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 1,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${targetLang}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 2,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${targetLang}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 3,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${targetLang}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 0,
    "time_limit": 15
  }
]

IMPORTANT:
1. "correct_answer" must be 0, 1, 2, or 3.
2. Escape all newlines in "code_snippet" as \\n.`;

    if (GEMINI_API_KEY) {
        const cleanKey = GEMINI_API_KEY.trim();
        // ⭐ တရားဝင် အမှန်တကယ် အလုပ်လုပ်သော Gemini 2.0 Flash မော်ဒယ်များ
        const models = ["gemini-2.0-flash", "gemini-2.0-flash-lite"];

        for (const modelName of models) {
            try {
                console.log(`[Gemini] Requesting via ${modelName} for ${targetLang}...`);
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            temperature: 0.7
                        }
                    }),
                    signal: AbortSignal.timeout(10000)
                });

                const data = await response.json();
                if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    let jsonText = data.candidates[0].content.parts[0].text.trim();
                    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

                    const parsed = JSON.parse(jsonText);
                    if (Array.isArray(parsed) && parsed.length === 5) {
                        console.log(`[Gemini AI Success via ${modelName}] Generated 5 Sololearn-style questions for ${targetLang}`);
                        return jsonText;
                    }
                } else if (data.error) {
                    console.warn(`[Gemini ${modelName} Error]:`, data.error.message);
                }
            } catch (error) {
                console.warn(`[Gemini ${modelName} Failed]:`, error.message);
            }
        }
    } else {
        console.warn("GEMINI_API_KEY Environment Variable is missing!");
    }

    // AI တောင်းယူမှု အဆင်မပြေပါက Backup နှင့် Fallback သို့ သွားမည်
    console.log("Trying PythonAnywhere Backup...");
    const pyData = await fetchFromPythonAnywhere(targetLang, "easy");
    if (pyData) {
        console.log(`[PythonAnywhere Success] Generated questions for ${targetLang}`);
        return pyData;
    }

    console.log(`[Fallback Used] Selected 5 Sololearn-style static questions for ${targetLang}`);
    return getRandomFallback(targetLang);
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

    ws.on('message', async (rawData) => {
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
                const fromUser = String(message.fromUser);
                const toUser = String(message.toUser);

                if (!registeredUserId) {
                    registeredUserId = fromUser;
                    clients.set(registeredUserId, ws);
                }

                const targetWs = clients.get(toUser);
                const sent = sendJson(targetWs, {
                    type: 'INVITE_RECEIVED',
                    fromUser: fromUser,
                    language: message.language
                });

                if (!sent) {
                    sendJson(ws, {
                        type: 'INVITE_FAILED',
                        message: `User ${toUser} is currently offline.`
                    });
                }
            }

            // 3. Invite Response (Friend Match)
            else if (message.type === 'INVITE_RESPONSE') {
                const hostUserId = String(message.toUser);
                const guestUserId = registeredUserId || String(message.fromUser || "GUEST");

                if (!registeredUserId && message.fromUser) {
                    registeredUserId = String(message.fromUser);
                    clients.set(registeredUserId, ws);
                }

                const senderWs = clients.get(hostUserId);

                if (message.action === 'ACCEPT') {
                    if (senderWs) {
                        const roomId = "FRIEND_ROOM_" + Math.floor(1000 + Math.random() * 9000);
                        const language = message.language || 'java';

                        rooms.set(roomId, { players: [hostUserId, guestUserId] });

                        const questionsPayload = await generateAIQuestion(language);

                        sendJson(senderWs, {
                            type: 'START_GAME',
                            roomId: roomId,
                            language: language,
                            opponentId: guestUserId,
                            questions: questionsPayload
                        });

                        sendJson(ws, {
                            type: 'START_GAME',
                            roomId: roomId,
                            language: language,
                            opponentId: hostUserId,
                            questions: questionsPayload
                        });

                        console.log(`Friend Match Started: User ${hostUserId} vs User ${guestUserId} in ${roomId}`);
                    } else {
                        sendJson(ws, {
                            type: 'INVITE_FAILED',
                            message: `Host user ${hostUserId} is no longer connected.`
                        });
                    }
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

                    const questionsPayload = await generateAIQuestion(language);

                    sendJson(ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: language,
                        opponentId: opponent.userId,
                        questions: questionsPayload
                    });

                    sendJson(opponent.ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: language,
                        opponentId: userId,
                        questions: questionsPayload
                    });

                    console.log(`Quick Match Started: User ${userId} vs User ${opponent.userId} in ${roomId}`);
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
                const { roomId, winnerId, player1Score, player2Score } = message;
                const room = rooms.get(roomId);

                if (room) {
                    const loserId = room.players.find(id => String(id) !== String(winnerId)) || null;

                    try {
                        fetch(`${PYTHONANYWHERE_URL}/api/match/finish`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                winner_id: winnerId,
                                loser_id: loserId,
                                room_id: roomId,
                                player1_score: player1Score || 100,
                                player2_score: player2Score || 50,
                                xp: 50,
                                loser_xp: 10
                            })
                        })
                        .then(res => res.json())
                        .then(data => {
                            console.log(`[PythonAnywhere Match Finish Success] Room: ${roomId}`, data);
                        })
                        .catch(err => {
                            console.error("[PythonAnywhere Match Finish Error]:", err.message);
                        });
                    } catch (err) {
                        console.error("Match Finish Request Exception:", err.message);
                    }

                    room.players.forEach(pId => {
                        const targetWs = clients.get(pId);
                        sendJson(targetWs, {
                            type: 'GAME_OVER',
                            winnerId: winnerId
                        });
                    });

                    rooms.delete(roomId);
                    console.log(`Game Over in Room ${roomId}. Winner: ${winnerId}, Loser: ${loserId}`);
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

            rooms.forEach((roomData, rId) => {
                if (roomData.players.includes(registeredUserId)) {
                    const opponentId = roomData.players.find(id => id !== registeredUserId);
                    if (opponentId) {
                        const opponentWs = clients.get(opponentId);
                        sendJson(opponentWs, {
                            type: 'OPPONENT_DISCONNECTED',
                            message: 'Your opponent disconnected from the match.'
                        });
                    }
                    rooms.delete(rId);
                }
            });

            console.log(`User ${registeredUserId} disconnected.`);
        }
    });

    ws.on('error', (err) => {
        console.error(`Socket error for User ${registeredUserId}:`, err.message);
    });
});
