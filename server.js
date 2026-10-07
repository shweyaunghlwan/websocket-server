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

// ⭐ Local Fallback Questions (C++, Java, Python ထည့်သွင်းထားသည်)
const FALLBACK_QUESTIONS = {
    java: [
        [{ title: "Array Reversal", description: "Write a method to reverse an array of integers.", starter_code: "public class Solution {\n    public static void reverse(int[] arr) {\n        // Write code here\n    }\n}" }],
        [{ title: "Palindrome Check", description: "Determine if a given string is a palindrome.", starter_code: "public class Solution {\n    public static boolean isPalindrome(String s) {\n        // Write code here\n        return false;\n    }\n}" }],
        [{ title: "Find Maximum", description: "Find the maximum number in an integer array.", starter_code: "public class Solution {\n    public static int findMax(int[] nums) {\n        // Write code here\n        return 0;\n    }\n}" }]
    ],
    cpp: [
        [{ title: "Reverse String (C++)", description: "Write a C++ function to reverse a string.", starter_code: "#include <iostream>\n#include <string>\nusing namespace std;\n\nvoid reverseString(string &s) {\n    // Write code here\n}" }],
        [{ title: "Palindrome Check (C++)", description: "Determine if a string is palindrome in C++.", starter_code: "#include <iostream>\n#include <string>\nusing namespace std;\n\nbool isPalindrome(string s) {\n    // Write code here\n    return false;\n}" }],
        [{ title: "Find Max Vector (C++)", description: "Find maximum value in a C++ std::vector<int>.", starter_code: "#include <vector>\n#include <algorithm>\nusing namespace std;\n\nint findMax(const vector<int>& nums) {\n    // Write code here\n    return 0;\n}" }]
    ],
    python: [
        [{ title: "Sum of List", description: "Write a function that returns the sum of elements in a list.", starter_code: "def sum_list(numbers):\n    # Write code here\n    pass" }],
        [{ title: "Count Vowels", description: "Count the number of vowels in a string.", starter_code: "def count_vowels(s):\n    # Write code here\n    pass" }]
    ]
};

function getRandomFallback(language) {
    const langKey = normalizeLanguage(language);
    const list = FALLBACK_QUESTIONS[langKey] || FALLBACK_QUESTIONS['java'];
    const randomIndex = Math.floor(Math.random() * list.length);
    return JSON.stringify(list[randomIndex]);
}

// ⭐ PythonAnywhere API မှ မေးခွန်း လှမ်းတောင်းသည့် Function
async function fetchFromPythonAnywhere(language, difficulty = "easy") {
    try {
        const url = `${PYTHONANYWHERE_URL}/api/get-question?language=${encodeURIComponent(language)}&difficulty=${encodeURIComponent(difficulty)}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
            const data = await res.text();
            JSON.parse(data); // Valid JSON စစ်သည်
            return data;
        }
    } catch (e) {
        console.warn("PythonAnywhere API Fetch Failed:", e.message);
    }
    return null;
}

// ⭐ ၃ ဆင့်ခံ မေးခွန်း ထုတ်ပေးသည့် Function (Gemini -> PythonAnywhere -> Local Fallback)
async function generateAIQuestion(language) {
    const targetLang = normalizeLanguage(language);
    const topics = ["Arrays & Strings", "Math & Logic", "Loops & Conditions", "Data Structures", "Algorithms"];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];
    const randomSeed = Math.floor(Math.random() * 100000);

    const prompt = `Generate a unique, creative intermediate coding challenge for ${targetLang}.
Focus Topic: ${randomTopic}. Random Seed: ${randomSeed}.
Return ONLY a valid JSON array containing a single object with the exact following structure:
[
  {
    "title": "Short Challenge Title",
    "description": "Clear problem statement with sample input/output format.",
    "starter_code": "Starter code function or setup in ${targetLang}"
  }
]
IMPORTANT: Ensure all newline characters inside starter_code are properly escaped as \\n so that it forms valid JSON. Do not include markdown code blocks like \`\`\`json. Return pure JSON string only.`;

    // Step 1: Gemini API Call
    try {
        if (GEMINI_API_KEY) {
            const cleanKey = GEMINI_API_KEY.trim();
            let apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent`;
            const headers = { 'Content-Type': 'application/json' };

            if (cleanKey.startsWith('AQ')) {
                headers['Authorization'] = `Bearer ${cleanKey}`;
            } else {
                apiUrl += `?key=${encodeURIComponent(cleanKey)}`;
            }

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
                signal: AbortSignal.timeout(8000)
            });

            const data = await response.json();
            if (response.ok && !data.error && data.candidates?.[0]?.content?.parts?.[0]?.text) {
                let jsonText = data.candidates[0].content.parts[0].text.trim();
                jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
                JSON.parse(jsonText);
                console.log(`[Gemini Success] Generated question for ${targetLang}`);
                return jsonText;
            } else if (data.error) {
                console.warn("[Gemini API Error]:", data.error.message);
            }
        } else {
            console.warn("GEMINI_API_KEY Environment Variable is missing!");
        }
    } catch (error) {
        console.warn("[Gemini Fetch Failed]:", error.message);
    }

    // Step 2: PythonAnywhere API Backup
    console.log("Trying PythonAnywhere Backup...");
    const pyData = await fetchFromPythonAnywhere(targetLang, "easy");
    if (pyData) {
        return pyData;
    }

    // Step 3: Local Fallback Questions
    console.log(`[Fallback Used] Selected static question for ${targetLang}`);
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

            // ⭐ 7. Game Over (PythonAnywhere Match Finish API သို့ ရလဒ်များ သွားရောက်သိမ်းဆည်းရန် ပြင်ဆင်ထားသည်)
            else if (message.type === 'GAME_OVER') {
                const { roomId, winnerId, player1Score, player2Score } = message;
                const room = rooms.get(roomId);

                if (room) {
                    // Winner မဟုတ်သော ကစားသမားအား Loser ID အဖြစ် ခွဲခြားသတ်မှတ်ခြင်း
                    const loserId = room.players.find(id => String(id) !== String(winnerId)) || null;

                    // PythonAnywhere API သို့ HTTP POST ပို့ဆောင်ခြင်း
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

                    // ကစားသမားများထံ GAME_OVER Message ဖြန့်ဝေခြင်း
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
