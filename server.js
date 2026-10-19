const { WebSocketServer, WebSocket } = require('ws');

// Render dynamic port သို့မဟုတ် local port 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // userId -> ws
let quickMatchQueue = []; // [{ userId, languageKey, rawLanguage, ws, joinedAt, timeoutTimer }]
const rooms = new Map(); // roomId -> { players: [userId1, userId2], language: rawLanguage, scores: Map(userId -> score), finishTimes: Map(userId -> time) }

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

// ⭐ Helper Function: Language နှင့် Difficulty (Basic / Intermediate) ကို ခွဲခြားထုတ်ယူရန်
function parseLangAndLevel(input) {
    if (!input) return { langKey: 'java', level: 'basic', fullKey: 'java_basic' };
    
    const str = String(input).toLowerCase().trim();
    
    let level = 'basic';
    if (str.includes('intermediate')) {
        level = 'intermediate';
    }

    let langKey = 'java';
    if (str.includes('c++') || str.includes('cpp')) langKey = 'cpp';
    else if (str.includes('python') || str.includes('py')) langKey = 'python';
    else if (str.includes('javascript') || str.includes('js')) langKey = 'javascript';
    else if (str.includes('java')) langKey = 'java';

    return {
        langKey,
        level,
        fullKey: `${langKey}_${level}`
    };
}

// ⭐ Basic & Intermediate အလိုက် XP တွက်ချက်ပေးသည့် Helper Function
function calculateMatchXP(rawLanguage, loserScore = 0) {
    const { level } = parseLangAndLevel(rawLanguage);
    
    const scoreBonus = Math.min(5, Math.max(0, Math.floor((loserScore / 200))));

    if (level === 'intermediate') {
        return {
            winnerXp: 80,
            loserXp: 15 + scoreBonus
        };
    } else {
        return {
            winnerXp: 50,
            loserXp: 5 + scoreBonus
        };
    }
}

// ⭐ Sololearn Style Static Fallback Questions (Randomized Fallbacks)
const FALLBACK_QUESTIONS = {
    cpp_basic: [
        [
            { type: "mcq", title: "C++ Variable Division", code_snippet: "int a = 5;\nint b = 2;\ncout << a / b;", description: "What is the output?", options: ["2.5", "2", "3", "Error"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "C++ Increment", code_snippet: "int x = 3;\ncout << x++ * 2;", description: "What will be printed?", options: ["6", "8", "7", "4"], correct_answer: 0, time_limit: 30 },
            { type: "mcq", title: "C++ Loop Output", code_snippet: "for(int i=0; i<3; i++) cout << i;", description: "What is printed?", options: ["012", "123", "0123", "3"], correct_answer: 0, time_limit: 30 },
            { type: "mcq", title: "C++ Bool Output", code_snippet: "bool flag = false;\ncout << !flag;", description: "What is printed?", options: ["0", "1", "false", "true"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "C++ Scope Output", code_snippet: "int x = 10;\nif(true) { int x = 5; }\ncout << x;", description: "What is the output?", options: ["10", "5", "15", "Error"], correct_answer: 0, time_limit: 30 }
        ],
        [
            { type: "mcq", title: "C++ Modulus", code_snippet: "int r = 10 % 3;\ncout << r;", description: "What is the output?", options: ["1", "3", "0", "10"], correct_answer: 0, time_limit: 30 },
            { type: "mcq", title: "C++ If-Else", code_snippet: "int score = 75;\nif(score > 80) cout << \"A\"; else cout << \"B\";", description: "What is printed?", options: ["A", "B", "75", "Error"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "C++ Array Access", code_snippet: "int arr[] = {10, 20, 30};\ncout << arr[1];", description: "What is printed?", options: ["10", "20", "30", "Error"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "C++ While Loop", code_snippet: "int x = 0;\nwhile(x < 2) { cout << x; x++; }", description: "What is printed?", options: ["01", "12", "012", "00"], correct_answer: 0, time_limit: 30 },
            { type: "mcq", title: "C++ Char Output", code_snippet: "char c = 'A';\ncout << (int)c;", description: "What is printed?", options: ["A", "65", "66", "Error"], correct_answer: 1, time_limit: 30 }
        ]
    ],
    java_basic: [
        [
            { type: "mcq", title: "Java Int Operations", code_snippet: "int x = 10;\nSystem.out.println(x / 4);", description: "What will be printed?", options: ["2.5", "2", "2.0", "3"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Java String Concat", code_snippet: "System.out.println(\"A\" + 1 + 2);", description: "What is the output?", options: ["A3", "A12", "Error", "A 1 2"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Java Loop Counter", code_snippet: "int c = 0;\nfor(int i=0; i<5; i+=2) c++;\nSystem.out.println(c);", description: "What will count be?", options: ["2", "3", "5", "1"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Java Ternary Operator", code_snippet: "int a = 5;\nint b = (a > 3) ? 10 : 20;\nSystem.out.println(b);", description: "What is the output?", options: ["5", "10", "20", "3"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Java Array Length", code_snippet: "int[] arr = {1, 2, 3, 4};\nSystem.out.println(arr.length);", description: "What is printed?", options: ["4", "3", "5", "Error"], correct_answer: 0, time_limit: 30 }
        ]
    ],
    python_basic: [
        [
            { type: "mcq", title: "Python Division", code_snippet: "print(5 // 2)", description: "What is the output?", options: ["2.5", "2", "2.0", "3"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Python String Multiply", code_snippet: "print('2' * 3)", description: "What is the output?", options: ["6", "222", "Error", "23"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Python List Append", code_snippet: "a = [1, 2]\na.append([3, 4])\nprint(len(a))", description: "What is len(a)?", options: ["4", "3", "2", "Error"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Python Range", code_snippet: "print(list(range(2, 5)))", description: "What will be printed?", options: ["[2, 3, 4, 5]", "[2, 3, 4]", "[3, 4, 5]", "[2, 5]"], correct_answer: 1, time_limit: 30 },
            { type: "mcq", title: "Python Boolean Evaluation", code_snippet: "print(bool([]) or bool('False'))", description: "What will be printed?", options: ["True", "False", "None", "Error"], correct_answer: 0, time_limit: 30 }
        ]
    ]
};

function getRandomFallback(rawLanguage) {
    const { fullKey } = parseLangAndLevel(rawLanguage);
    const sets = FALLBACK_QUESTIONS[fullKey] || FALLBACK_QUESTIONS['java_basic'];
    const randomIndex = Math.floor(Math.random() * sets.length);
    return JSON.stringify(sets[randomIndex]);
}

// ⭐ PythonAnywhere API မှ မေးခွန်း လှမ်းတောင်းသည့် Function
async function fetchFromPythonAnywhere(rawLanguage) {
    const { langKey, level } = parseLangAndLevel(rawLanguage);
    try {
        const url = `${PYTHONANYWHERE_URL}/api/get-question?language=${encodeURIComponent(langKey)}&difficulty=${encodeURIComponent(level)}`;
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

// ⭐ မေးခွန်းများ မထပ်စေရန် Temperature မြှင့်တင်ထားသော AI Generator
async function generateAIQuestion(rawLanguage) {
    const { langKey, level, fullKey } = parseLangAndLevel(rawLanguage);
    const randomSeed = Date.now() + Math.floor(Math.random() * 1000000);

    const levelDescription = level === 'intermediate'
        ? "INTERMEDIATE level (focusing on memory management, pointers/references, classes/OOP concepts, STL/Collections, exception handling, dynamic allocation, and intermediate code output prediction)."
        : "BASIC / BEGINNER level (focusing on fundamental syntax, loops, conditional logic, basic variable scopes, arrays, and simple code output prediction).";

    const prompt = `Generate a UNIQUE JSON array of exactly 5 completely fresh Sololearn-style fast-paced coding challenge questions for '${langKey}' programming language at ${levelDescription}
Unique Random Seed: ${randomSeed}. (Make sure questions are newly randomized and different from standard textbook questions).

Goal: Test quick code output prediction, syntax awareness, logic, and debugging in a 1v1 challenge matching difficulty level '${level.toUpperCase()}'.

Rules:
- Generate 5 Multiple Choice Questions (type: "mcq").
- Focus heavily on "What is the output of this code snippet?" or "Fill in the blank/syntax logic".
- Provide a short, realistic code snippet for each question in "code_snippet".
- Questions MUST STRICTLY match the ${level.toUpperCase()} difficulty level.

Exact JSON Format required:
[
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 0,
    "time_limit": 30
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 1,
    "time_limit": 30
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 2,
    "time_limit": 30
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 3,
    "time_limit": 30
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 0,
    "time_limit": 30
  }
]

IMPORTANT:
1. "correct_answer" must be 0, 1, 2, or 3.
2. Escape all newlines in "code_snippet" as \\n.`;

    if (GEMINI_API_KEY) {
        const cleanKey = GEMINI_API_KEY.trim();
        const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

        for (const modelName of models) {
            try {
                console.log(`[Gemini] Requesting via ${modelName} for [${fullKey}]...`);
                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(cleanKey)}`;

                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            temperature: 0.9
                        }
                    }),
                    signal: AbortSignal.timeout(8000)
                });

                const data = await response.json();
                if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    let jsonText = data.candidates[0].content.parts[0].text.trim();
                    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

                    const parsed = JSON.parse(jsonText);
                    if (Array.isArray(parsed) && parsed.length === 5) {
                        console.log(`[Gemini AI Success via ${modelName}] Generated 5 unique questions for [${fullKey}]`);
                        return jsonText;
                    }
                }
            } catch (error) {
                console.warn(`[Gemini ${modelName} Failed]:`, error.message);
            }
        }
    }

    // Backup & Fallback
    console.log("Trying PythonAnywhere Backup...");
    const pyData = await fetchFromPythonAnywhere(rawLanguage);
    if (pyData) {
        return pyData;
    }

    console.log(`[Fallback Used] Selected random static questions for [${fullKey}]`);
    return getRandomFallback(rawLanguage);
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
                        
                        const rawLang = message.language || 'Java (Basic)';

                        rooms.set(roomId, { 
                            players: [hostUserId, guestUserId], 
                            language: rawLang,
                            scores: new Map(),
                            finishTimes: new Map()
                        });

                        const questionsPayload = await generateAIQuestion(rawLang);

                        sendJson(senderWs, {
                            type: 'START_GAME',
                            roomId: roomId,
                            language: rawLang,
                            opponentId: guestUserId,
                            questions: questionsPayload
                        });

                        sendJson(ws, {
                            type: 'START_GAME',
                            roomId: roomId,
                            language: rawLang,
                            opponentId: hostUserId,
                            questions: questionsPayload
                        });

                        console.log(`Friend Match Started: User ${hostUserId} vs User ${guestUserId} in ${roomId} [Language: ${rawLang}]`);
                    }
                }
            }
            // 4. Quick Match Join
            else if (message.type === 'QUICK_MATCH_JOIN') {
                const userId = String(message.userId);
                const rawLanguage = String(message.language || 'Java (Basic)').trim();
                const { fullKey } = parseLangAndLevel(rawLanguage);

                registeredUserId = userId;
                clients.set(userId, ws);

                removeFromQueue(userId);

                const opponentIndex = quickMatchQueue.findIndex(p =>
                    p.languageKey === fullKey &&
                    p.userId !== userId &&
                    p.ws.readyState === WebSocket.OPEN
                );

                if (opponentIndex !== -1) {
                    const [opponent] = quickMatchQueue.splice(opponentIndex, 1);
                    if (opponent.timeoutTimer) {
                        clearTimeout(opponent.timeoutTimer);
                    }

                    const roomId = "QUICK_ROOM_" + Math.floor(1000 + Math.random() * 9000);
                    
                    rooms.set(roomId, { 
                        players: [userId, opponent.userId], 
                        language: rawLanguage,
                        scores: new Map(),
                        finishTimes: new Map()
                    });

                    const questionsPayload = await generateAIQuestion(rawLanguage);

                    sendJson(ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: rawLanguage,
                        opponentId: opponent.userId,
                        questions: questionsPayload
                    });

                    sendJson(opponent.ws, {
                        type: "QUICK_MATCH_START",
                        roomId: roomId,
                        language: rawLanguage,
                        opponentId: userId,
                        questions: questionsPayload
                    });

                    console.log(`Quick Match Started: User ${userId} vs User ${opponent.userId} in ${roomId} [Mode: ${fullKey}]`);
                } else {
                    const timeoutTimer = setTimeout(() => {
                        console.log(`User ${userId} Quick Match timed out for [${fullKey}].`);
                        removeFromQueue(userId, ws);

                        sendJson(ws, {
                            type: "QUICK_MATCH_TIMEOUT",
                            message: "No active opponent found matching your level within time limit."
                        });
                    }, MATCH_TIMEOUT_MS);

                    quickMatchQueue.push({
                        userId,
                        languageKey: fullKey,
                        rawLanguage,
                        ws,
                        joinedAt: Date.now(),
                        timeoutTimer
                    });
                }
            }

            // 5. Quick Match Cancel
            else if (message.type === 'QUICK_MATCH_CANCEL') {
                const userId = String(message.userId);
                removeFromQueue(userId, ws);
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

            // 7. ⭐ ထွက်သွားသူရှိပါက ကျန်ခဲ့သူ တန်းအနိုင်ရစေရန် (Surrender Handler)
            else if (message.type === 'SURRENDER') {
                const { roomId, userId } = message;
                const room = rooms.get(roomId);

                if (room) {
                    const exitingUserId = String(userId);
                    const opponentId = room.players.find(pId => pId !== exitingUserId);

                    if (opponentId) {
                        const rawLang = room.language || 'Java (Basic)';
                        const { winnerXp, loserXp } = calculateMatchXP(rawLang, 0);

                        room.players.forEach(pId => {
                            const targetWs = clients.get(pId);
                            sendJson(targetWs, {
                                type: 'GAME_OVER',
                                winnerId: opponentId,
                                winnerXp: winnerXp,
                                loserXp: loserXp
                            });
                        });

                        rooms.delete(roomId);
                        console.log(`[Surrender] User ${exitingUserId} left the match. Opponent ${opponentId} wins automatically in Room ${roomId}`);
                    }
                }
            }

            // 8. ⭐ အမှတ်နှင့် အချိန်ကို အခြေခံ၍ အနိုင်အရှုံး ဆုံးဖြတ်သော Game Over Handler
            else if (message.type === 'GAME_OVER') {
                const { roomId, userId, score } = message;
                const room = rooms.get(roomId);

                if (room) {
                    const currentUserId = String(userId);
                    const currentScore = typeof score === 'number' ? score : 0;

                    room.scores.set(currentUserId, currentScore);
                    room.finishTimes.set(currentUserId, Date.now());

                    console.log(`[Game Over Info] Room: ${roomId} | User ${currentUserId} finished with score: ${currentScore}`);

                    if (room.scores.size >= 2 || room.players.length === 1) {
                        const playerIds = room.players;
                        const p1 = String(playerIds[0]);
                        const p2 = String(playerIds[1] || playerIds[0]);

                        const score1 = room.scores.get(p1) || 0;
                        const score2 = room.scores.get(p2) || 0;

                        let winnerId = p1;
                        let loserId = p2;

                        if (score1 !== score2) {
                            winnerId = score1 > score2 ? p1 : p2;
                            loserId = score1 > score2 ? p2 : p1;
                        } else {
                            const time1 = room.finishTimes.get(p1) || 0;
                            const time2 = room.finishTimes.get(p2) || 0;
                            winnerId = time1 <= time2 ? p1 : p2;
                            loserId = time1 <= time2 ? p2 : p1;
                        }

                        const loserScore = Math.min(score1, score2);
                        const rawLang = room.language || 'Java (Basic)';
                        const { winnerXp, loserXp } = calculateMatchXP(rawLang, loserScore);

                        try {
                            fetch(`${PYTHONANYWHERE_URL}/api/match/finish`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    winner_id: winnerId,
                                    loser_id: loserId,
                                    room_id: roomId,
                                    xp: winnerXp,
                                    loser_xp: loserXp
                                })
                            })
                            .then(res => res.json())
                            .then(data => {
                                console.log(`[Match Finish Success] Room: ${roomId} | Winner: ${winnerId}, Loser: ${loserId}`, data);
                            })
                            .catch(err => {
                                console.error("[Match Finish Error]:", err.message);
                            });
                        } catch (err) {
                            console.error("Match Finish Request Exception:", err.message);
                        }

                        room.players.forEach(pId => {
                            const targetWs = clients.get(pId);
                            sendJson(targetWs, {
                                type: 'GAME_OVER',
                                winnerId: winnerId,
                                winnerXp: winnerXp,
                                loserXp: loserXp
                            });
                        });

                        rooms.delete(roomId);
                        console.log(`Game Over Processed in Room ${roomId}. Winner: ${winnerId} (Score: ${room.scores.get(winnerId)}), Loser: ${loserId}`);
                    }
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
        }
    });

    ws.on('error', (err) => {
        console.error(`Socket error for User ${registeredUserId}:`, err.message);
    });
});
