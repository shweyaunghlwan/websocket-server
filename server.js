const { WebSocketServer, WebSocket } = require('ws');

// Render dynamic port သို့မဟုတ် local port 8080
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // userId -> ws
let quickMatchQueue = []; // [{ userId, languageKey, rawLanguage, ws, joinedAt, timeoutTimer }]
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

// ⭐ Sololearn Style Static Fallback Questions (Basic & Intermediate Separated)
const FALLBACK_QUESTIONS = {
    cpp_basic: [
        { type: "mcq", title: "C++ Variable Division", code_snippet: "int a = 5;\nint b = 2;\ncout << a / b;", description: "What is the output?", options: ["2.5", "2", "3", "Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Increment", code_snippet: "int x = 3;\ncout << x++ * 2;", description: "What will be printed?", options: ["6", "8", "7", "4"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "C++ Loop Output", code_snippet: "for(int i=0; i<3; i++) cout << i;", description: "What is printed?", options: ["012", "123", "0123", "3"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "C++ Bool Output", code_snippet: "bool flag = false;\ncout << !flag;", description: "What is printed?", options: ["0", "1", "false", "true"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Scope Output", code_snippet: "int x = 10;\nif(true) { int x = 5; }\ncout << x;", description: "What is the output?", options: ["10", "5", "15", "Error"], correct_answer: 0, time_limit: 15 }
    ],
    cpp_intermediate: [
        { type: "mcq", title: "C++ Pointer Modification", code_snippet: "int a = 10;\nint *p = &a;\n*p = 20;\ncout << a;", description: "What is the output?", options: ["10", "20", "Garbage value", "Compilation Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Vector Operation", code_snippet: "vector<int> v = {1, 2, 3};\nv.pop_back();\ncout << v.size();", description: "What is the size of vector v?", options: ["3", "2", "1", "0"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Reference Parameter", code_snippet: "void update(int &r) { r *= 2; }\nint main() { int x = 5; update(x); cout << x; }", description: "What is the output?", options: ["5", "10", "20", "Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "C++ Dynamic Memory", code_snippet: "int *p = new int(50);\ncout << *p;\ndelete p;", description: "What will be printed?", options: ["50", "Address of p", "Garbage value", "Error"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "C++ Inheritance", code_snippet: "class A { public: int x = 1; };\nclass B : public A {};\nB b;\ncout << b.x;", description: "What is the output?", options: ["1", "0", "Private Error", "Compilation Error"], correct_answer: 0, time_limit: 15 }
    ],
    java_basic: [
        { type: "mcq", title: "Java Int Operations", code_snippet: "int x = 10;\nSystem.out.println(x / 4);", description: "What will be printed?", options: ["2.5", "2", "2.0", "3"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java String Concat", code_snippet: "System.out.println(\"A\" + 1 + 2);", description: "What is the output?", options: ["A3", "A12", "Error", "A 1 2"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Loop Counter", code_snippet: "int c = 0;\nfor(int i=0; i<5; i+=2) c++;\nSystem.out.println(c);", description: "What will count be?", options: ["2", "3", "5", "1"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Ternary Operator", code_snippet: "int a = 5;\nint b = (a > 3) ? 10 : 20;\nSystem.out.println(b);", description: "What is the output?", options: ["5", "10", "20", "3"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Array Length", code_snippet: "int[] arr = {1, 2, 3, 4};\nSystem.out.println(arr.length);", description: "What is printed?", options: ["4", "3", "5", "Error"], correct_answer: 0, time_limit: 15 }
    ],
    java_intermediate: [
        { type: "mcq", title: "Java String Equality", code_snippet: "String a = \"Java\";\nString b = new String(\"Java\");\nSystem.out.println(a == b);", description: "What is the output?", options: ["true", "false", "null", "Compilation Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Array Bound Exception", code_snippet: "int[] a = {1, 2, 3};\nSystem.out.println(a[3]);", description: "What is the result?", options: ["3", "0", "ArrayIndexOutOfBoundsException", "Compilation Error"], correct_answer: 2, time_limit: 15 },
        { type: "mcq", title: "Java Static Block", code_snippet: "class Test { static int x = 5; }\n// Inside main: Test t = null; System.out.println(t.x);", description: "What is printed?", options: ["NullPointerException", "5", "0", "Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Polymorphism", code_snippet: "class A { void show(){ System.out.print(\"A\"); } }\nclass B extends A { void show(){ System.out.print(\"B\"); } }\nA obj = new B(); obj.show();", description: "What is printed?", options: ["A", "B", "AB", "Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Java Try Catch Finally", code_snippet: "try { return; } finally { System.out.println(\"Finally\"); }", description: "What happens?", options: ["Finally is printed", "Nothing is printed", "Exception thrown", "Compilation Error"], correct_answer: 0, time_limit: 15 }
    ],
    python_basic: [
        { type: "mcq", title: "Python Division", code_snippet: "print(5 // 2)", description: "What is the output?", options: ["2.5", "2", "2.0", "3"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python String Multiply", code_snippet: "print('2' * 3)", description: "What is the output?", options: ["6", "222", "Error", "23"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python List Append", code_snippet: "a = [1, 2]\na.append([3, 4])\nprint(len(a))", description: "What is len(a)?", options: ["4", "3", "2", "Error"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python Range", code_snippet: "print(list(range(2, 5)))", description: "What will be printed?", options: ["[2, 3, 4, 5]", "[2, 3, 4]", "[3, 4, 5]", "[2, 5]"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python Boolean Evaluation", code_snippet: "print(bool([]) or bool('False'))", description: "What will be printed?", options: ["True", "False", "None", "Error"], correct_answer: 0, time_limit: 15 }
    ],
    python_intermediate: [
        { type: "mcq", title: "Python List Slicing", code_snippet: "nums = [10, 20, 30, 40, 50]\nprint(nums[1:4])", description: "What will be printed?", options: ["[20, 30, 40]", "[10, 20, 30]", "[20, 30]", "[30, 40, 50]"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "Python Dict Get Default", code_snippet: "d = {'a': 1, 'b': 2}\nprint(d.get('c', 3))", description: "What is the output?", options: ["None", "KeyError", "3", "c"], correct_answer: 2, time_limit: 15 },
        { type: "mcq", title: "Python Lambda Function", code_snippet: "f = lambda x, y: x if x > y else y\nprint(f(7, 4))", description: "What is the output?", options: ["7", "4", "True", "SyntaxError"], correct_answer: 0, time_limit: 15 },
        { type: "mcq", title: "Python List Comprehension", code_snippet: "a = [x*x for x in range(3)]\nprint(a)", description: "What is printed?", options: ["[1, 2, 3]", "[0, 1, 4]", "[0, 1, 2]", "[1, 4, 9]"], correct_answer: 1, time_limit: 15 },
        { type: "mcq", title: "Python Mutable Default Parameter", code_snippet: "def add(x, L=[]):\n L.append(x)\n return L\nadd(1)\nprint(add(2))", description: "What is printed?", options: ["[2]", "[1, 2]", "[1]", "Error"], correct_answer: 1, time_limit: 15 }
    ]
};

function getRandomFallback(rawLanguage) {
    const { fullKey } = parseLangAndLevel(rawLanguage);
    const list = FALLBACK_QUESTIONS[fullKey] || FALLBACK_QUESTIONS['java_basic'];
    return JSON.stringify(list);
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

// ⭐ Sololearn-style Fast 5 MCQ/Code Output Questions AI Generator (Level-Aware Prompt & Optimized Speed)
async function generateAIQuestion(rawLanguage) {
    const { langKey, level, fullKey } = parseLangAndLevel(rawLanguage);
    const randomSeed = Math.floor(Math.random() * 100000);

    const levelDescription = level === 'intermediate'
        ? "INTERMEDIATE level (focusing on memory management, pointers/references, classes/OOP concepts, STL/Collections, exception handling, dynamic allocation, and intermediate code output prediction)."
        : "BASIC / BEGINNER level (focusing on fundamental syntax, loops, conditional logic, basic variable scopes, arrays, and simple code output prediction).";

    const prompt = `Generate a JSON array of exactly 5 Sololearn-style fast-paced coding challenge questions for '${langKey}' programming language at ${levelDescription}
Seed: ${randomSeed}.

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
    "title": "Short Question Title (e.g., Output Prediction)",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question (e.g. What will be printed?)",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 0,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 1,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 2,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
    "description": "Clear question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct_answer": 3,
    "time_limit": 15
  },
  {
    "type": "mcq",
    "title": "Short Question Title",
    "code_snippet": "short code snippet in ${langKey}",
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
        const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

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
                            temperature: 0.3 // ပိုမိုမြန်ဆန်စွာ အဖြေထုတ်ရန် သတ်မှတ်ထားသည်
                        }
                    }),
                    signal: AbortSignal.timeout(8000) // Timeout ကို ၈ စက္ကန့်ထိ တိုးမြှင့်လိုက်သည်
                });

                const data = await response.json();
                if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
                    let jsonText = data.candidates[0].content.parts[0].text.trim();
                    jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

                    const parsed = JSON.parse(jsonText);
                    if (Array.isArray(parsed) && parsed.length === 5) {
                        console.log(`[Gemini AI Success via ${modelName}] Generated 5 Sololearn-style questions for [${fullKey}]`);
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

    // Backup & Fallback
    console.log("Trying PythonAnywhere Backup...");
    const pyData = await fetchFromPythonAnywhere(rawLanguage);
    if (pyData) {
        console.log(`[PythonAnywhere Success] Generated questions for [${fullKey}]`);
        return pyData;
    }

    console.log(`[Fallback Used] Selected static questions for [${fullKey}]`);
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

                        rooms.set(roomId, { players: [hostUserId, guestUserId] });

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

                        console.log(`Friend Match Started: User ${hostUserId} vs User ${guestUserId} in ${roomId}`);
                    } else {
                        sendJson(ws, {
                            type: 'INVITE_FAILED',
                            message: `Host user ${hostUserId} is no longer connected.`
                        });
                    }
                }
            }

            // 4. Quick Match Join (Match users with EXACT same Language & Level)
            else if (message.type === 'QUICK_MATCH_JOIN') {
                const userId = String(message.userId);
                const rawLanguage = String(message.language || 'Java (Basic)').trim();
                const { fullKey } = parseLangAndLevel(rawLanguage);

                registeredUserId = userId;
                clients.set(userId, ws);

                removeFromQueue(userId);

                // ⭐ Exact match for both Language and Level
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
                    rooms.set(roomId, { players: [userId, opponent.userId] });

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

                    console.log(`User ${userId} joined Quick Match queue for [${fullKey}]. Queue size: ${quickMatchQueue.length}`);
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
