const express = require('express');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Existing API Routes ──────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
    res.json({ name: 'Shahmeer', age: 12, server: 'Node.js + Express', status: 'online', uptime: Math.floor(process.uptime()) + ' seconds' });
});

app.post('/api/contact', (req, res) => {
    const { name, email, message } = req.body;
    if (!name || !email || !message) return res.status(400).json({ error: 'All fields are required.' });
    const messagesFile = path.join(__dirname, 'data', 'messages.json');
    const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    messages.push({ name, email, message, date: new Date().toISOString() });
    fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));
    res.json({ message: `Thanks ${name}! Your message was saved.` });
});

const MESSAGES_PASSWORD = 'shahmeer123';
app.get('/api/messages', (req, res) => {
    if (req.headers['x-password'] !== MESSAGES_PASSWORD) return res.status(401).json({ error: 'Wrong password.' });
    const messages = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'messages.json'), 'utf8'));
    res.json(messages);
});

// ─── Page Routes ──────────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/about',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/messages',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'messages.html')));
app.get('/contact',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'contact.html')));
app.get('/battleship', (req, res) => res.sendFile(path.join(__dirname, 'public', 'battleship.html')));
app.get('/drawing',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'drawing.html')));

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

// ─── Drawing Game Logic ───────────────────────────────────────────────────────
const DRAW_WORDS = [
    'cat','dog','fish','bird','tree','sun','moon','star','house','car','boat',
    'plane','train','bike','apple','banana','pizza','cake','ice cream','guitar',
    'piano','drum','elephant','giraffe','penguin','dolphin','shark','mountain',
    'volcano','rainbow','cloud','lightning','castle','tower','bridge','lighthouse',
    'rocket','robot','alien','astronaut','crown','sword','shield','snowman',
    'pumpkin','cactus','mushroom','skateboard','submarine','telescope','compass',
    'butterfly','scorpion','octopus','crab','turtle','waterfall','tornado',
    'diamond','trophy','basketball','football','tennis','firework','balloon',
    'umbrella','kite','candle','lantern','hourglass','pirate','ninja','wizard',
    'knight','spaceship','satellite','comet','sushi','taco','hot dog','burger',
    'microscope','blizzard','tornado','sunrise','campfire','igloo','hammock',
    'helicopter','parachute','surfboard','bowling','archery','chess','popcorn',
    'doughnut','watermelon','pineapple','broccoli','flamingo','peacock','seahorse',
    'mermaid','dragon','unicorn','vampire','zombie','witch','superhero','detective',
];

const drawRooms = {};

function genDrawCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function getWordHint(word, revealedIndices) {
    return word.split('').map((c, i) =>
        c === ' ' ? '/' : (revealedIndices.includes(i) ? c : '_')
    ).join(' ');
}

function pickWords() {
    return [...DRAW_WORDS].sort(() => Math.random() - 0.5).slice(0, 3);
}

function drawRoomState(room) {
    return {
        code: room.code, host: room.host, phase: room.phase,
        players: room.players.map(p => ({ id: p.id, username: p.username, score: p.score, hasDrawn: p.hasDrawn })),
    };
}

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

const ROUNDS_PER_PLAYER = 8;

function startChoosingPhase(code) {
    const room = drawRooms[code];
    if (!room) return;

    if (room.drawerIndex >= room.players.length * ROUNDS_PER_PLAYER) { endDrawGame(code); return; }

    // Cycle through players repeatedly
    const drawer = room.players[room.drawerIndex % room.players.length];
    if (!drawer) { endDrawGame(code); return; }

    room.currentDrawer = drawer.id;
    room.phase         = 'choosing';
    room.wordChoices   = pickWords();
    room.correctGuessers = [];

    io.to(code).emit('draw-phase-choosing', {
        drawer: { id: drawer.id, username: drawer.username }
    });
    io.to(drawer.id).emit('draw-word-choices', { words: room.wordChoices });

    room.chooseTimeout = setTimeout(() => {
        if (room.phase === 'choosing' && drawRooms[code]) startDrawingPhase(code, room.wordChoices[0]);
    }, 12000);
}

function startDrawingPhase(code, word) {
    const room = drawRooms[code];
    if (!room) return;
    clearTimeout(room.chooseTimeout);

    room.currentWord    = word;
    room.phase          = 'drawing';
    room.timeLeft       = 80;
    room.hintRevealed   = [];
    room.correctGuessers = [];

    const drawer = room.players.find(p => p.id === room.currentDrawer);
    io.to(code).emit('draw-phase-drawing', {
        drawer:      { id: room.currentDrawer, username: drawer?.username },
        hint:        getWordHint(word, []),
        timeLeft:    80,
        totalRounds: ROUNDS_PER_PLAYER,
        round:       Math.floor(room.drawerIndex / room.players.length) + 1,
    });
    io.to(room.currentDrawer).emit('draw-your-word', { word });

    room.timer = setInterval(() => {
        if (!drawRooms[code]) { clearInterval(room.timer); return; }
        room.timeLeft--;

        if (room.timeLeft === 40 && room.hintRevealed.length === 0) {
            const firstIdx = room.currentWord.split('').findIndex(c => c !== ' ');
            if (firstIdx >= 0) {
                room.hintRevealed.push(firstIdx);
                io.to(code).emit('draw-hint', { hint: getWordHint(room.currentWord, room.hintRevealed) });
            }
        }

        const guessers   = room.players.filter(p => p.id !== room.currentDrawer);
        const allGuessed = guessers.length > 0 && guessers.every(p => room.correctGuessers.includes(p.id));

        if (room.timeLeft <= 0 || allGuessed) {
            clearInterval(room.timer);
            endDrawRound(code);
        } else {
            io.to(code).emit('draw-tick', { timeLeft: room.timeLeft });
        }
    }, 1000);
}

function endDrawRound(code) {
    const room = drawRooms[code];
    if (!room) return;
    clearInterval(room.timer);
    room.phase = 'round-end';

    io.to(code).emit('draw-phase-round-end', {
        word:   room.currentWord,
        scores: room.players.map(p => ({ id: p.id, username: p.username, score: p.score })),
    });

    setTimeout(() => {
        if (!drawRooms[code]) return;
        room.drawerIndex++;
        io.to(code).emit('draw-clear');
        startChoosingPhase(code);
    }, 5000);
}

function endDrawGame(code) {
    const room = drawRooms[code];
    if (!room) return;
    room.phase = 'game-end';
    const leaderboard = [...room.players]
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ rank: i + 1, username: p.username, score: p.score }));
    io.to(code).emit('draw-game-end', { leaderboard });
}

// ─── Battleship Game Logic ────────────────────────────────────────────────────
const rooms = {};

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function checkHit(ships, x, y) {
    for (const ship of ships) {
        for (const cell of ship.cells) {
            if (cell.x === x && cell.y === y) return { hit: true, ship };
        }
    }
    return { hit: false };
}

function allSunk(ships, shots) {
    for (const ship of ships) {
        for (const cell of ship.cells) {
            if (!shots.some(s => s.x === cell.x && s.y === cell.y)) return false;
        }
    }
    return true;
}

io.on('connection', (socket) => {

    // ── Create a new room ──────────────────────────────────────────────────────
    socket.on('create-room', () => {
        let code;
        do { code = generateCode(); } while (rooms[code]);

        rooms[code] = {
            players: [socket.id],
            playerNums: { [socket.id]: 1 },
            ships: {},
            shots: { [socket.id]: [] },
            currentTurn: null,
            phase: 'waiting'
        };

        socket.join(code);
        socket.roomCode = code;
        socket.emit('room-created', { code });
    });

    // ── Join an existing room ──────────────────────────────────────────────────
    socket.on('join-room', ({ code }) => {
        const room = rooms[code];
        if (!room)                     return socket.emit('join-error', 'Room not found. Check the code.');
        if (room.players.length >= 2)  return socket.emit('join-error', 'Room is full.');
        if (room.phase !== 'waiting')  return socket.emit('join-error', 'Game already started.');

        room.players.push(socket.id);
        room.playerNums[socket.id] = 2;
        room.shots[socket.id] = [];
        room.phase = 'placing';

        socket.join(code);
        socket.roomCode = code;

        io.to(code).emit('start-placement');
        io.to(code).emit('chat-message', { sender: 'System', text: 'Both players connected! Place your ships.' });
    });

    // ── Ships placed by a player ───────────────────────────────────────────────
    socket.on('ships-placed', ({ ships }) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        room.ships[socket.id] = ships;
        socket.emit('placement-confirmed');

        const bothPlaced = room.players.every(pid => room.ships[pid]);
        if (bothPlaced) {
            room.phase = 'playing';
            room.currentTurn = room.players[0];
            io.to(code).emit('game-start', { firstTurn: room.players[0] });
            io.to(code).emit('chat-message', { sender: 'System', text: 'All ships placed — game on! Player 1 goes first.' });
        }
    });

    // ── Player fires a shot ────────────────────────────────────────────────────
    socket.on('fire', ({ x, y }) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room || room.phase !== 'playing') return;
        if (room.currentTurn !== socket.id)    return;

        const opponentId    = room.players.find(p => p !== socket.id);
        const opponentShips = room.ships[opponentId];

        if (room.shots[socket.id].some(s => s.x === x && s.y === y)) return; // already fired here

        room.shots[socket.id].push({ x, y });

        const { hit, ship } = checkHit(opponentShips, x, y);

        let sunk = false;
        if (hit) {
            const hitCount = room.shots[socket.id].filter(s =>
                ship.cells.some(c => c.x === s.x && c.y === s.y)
            ).length;
            sunk = hitCount === ship.cells.length;
        }

        const won = hit && allSunk(opponentShips, room.shots[socket.id]);

        io.to(code).emit('shot-result', {
            shooter: socket.id,
            x, y, hit, sunk,
            sunkShipName: sunk ? ship.name : null,
            won
        });

        if (won) {
            room.phase = 'finished';
            const winnerNum = room.playerNums[socket.id];
            io.to(code).emit('game-over', { winner: socket.id, winnerNum });
        } else {
            // Hit = shoot again, miss = switch turns
            if (!hit) room.currentTurn = opponentId;
        }
    });

    // ── Chat message ───────────────────────────────────────────────────────────
    socket.on('chat-message', ({ text }) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!code || !room) return;
        const num = room.playerNums[socket.id] || '?';
        io.to(code).emit('chat-message', {
            sender: `Player ${num}`,
            text: text.trim().substring(0, 200)
        });
    });

    // ── Player disconnects ─────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        // Battleship cleanup
        const code = socket.roomCode;
        if (code && rooms[code]) {
            io.to(code).emit('player-disconnected');
            delete rooms[code];
        }
        // Drawing game cleanup
        const dcode = socket.drawRoom;
        const droom = dcode && drawRooms[dcode];
        if (droom) {
            droom.players = droom.players.filter(p => p.id !== socket.id);
            if (droom.players.length === 0) {
                clearInterval(droom.timer);
                clearTimeout(droom.chooseTimeout);
                delete drawRooms[dcode];
            } else {
                if (droom.host === socket.id) droom.host = droom.players[0].id;
                io.to(dcode).emit('draw-room-update', drawRoomState(droom));
                io.to(dcode).emit('draw-chat', { type: 'system', text: `A player disconnected.` });
                // If current drawer left during drawing, end round early
                if (droom.currentDrawer === socket.id && droom.phase === 'drawing') {
                    clearInterval(droom.timer);
                    endDrawRound(dcode);
                }
            }
        }
    });

    // ════════════════════════════════════════════════════════════════════════════
    // ─── Drawing Game Socket Handlers ────────────────────────────────────────
    // ════════════════════════════════════════════════════════════════════════════

    socket.on('draw-create', ({ username }) => {
        let code;
        do { code = genDrawCode(); } while (drawRooms[code] || rooms[code]);

        drawRooms[code] = {
            code, host: socket.id, phase: 'lobby',
            players: [{ id: socket.id, username, score: 0, hasDrawn: false }],
            drawerIndex: 0, currentDrawer: null, currentWord: null,
            wordChoices: [], timeLeft: 0, hintRevealed: [],
            correctGuessers: [], timer: null, chooseTimeout: null,
        };

        socket.join(code);
        socket.drawRoom = code;
        socket.emit('draw-joined', { code, myId: socket.id, room: drawRoomState(drawRooms[code]) });
    });

    socket.on('draw-join', ({ code, username }) => {
        const c    = code.toUpperCase();
        const room = drawRooms[c];
        if (!room)                    return socket.emit('draw-error', 'Room not found.');
        if (room.phase !== 'lobby')   return socket.emit('draw-error', 'Game already started.');
        if (room.players.length >= 8) return socket.emit('draw-error', 'Room is full (8 max).');
        if (room.players.some(p => p.username.toLowerCase() === username.toLowerCase()))
            return socket.emit('draw-error', 'Username taken in this room.');

        room.players.push({ id: socket.id, username, score: 0, hasDrawn: false });
        socket.join(c);
        socket.drawRoom = c;

        socket.emit('draw-joined', { code: c, myId: socket.id, room: drawRoomState(room) });
        socket.to(c).emit('draw-room-update', drawRoomState(room));
        io.to(c).emit('draw-chat', { type: 'system', text: `${username} joined!` });
    });

    socket.on('draw-start', () => {
        const room = drawRooms[socket.drawRoom];
        if (!room || room.host !== socket.id)   return;
        if (room.players.length < 2)            return socket.emit('draw-error', 'Need at least 2 players.');
        if (room.phase !== 'lobby')             return;
        room.phase       = 'starting';
        room.drawerIndex = 0;
        io.to(room.code).emit('draw-starting');
        setTimeout(() => { if (drawRooms[room.code]) startChoosingPhase(room.code); }, 1500);
    });

    socket.on('draw-choose-word', ({ word }) => {
        const room = drawRooms[socket.drawRoom];
        if (!room || room.currentDrawer !== socket.id || room.phase !== 'choosing') return;
        if (!room.wordChoices.includes(word)) return;
        startDrawingPhase(room.code, word);
    });

    socket.on('draw-stroke', (data) => {
        const room = drawRooms[socket.drawRoom];
        if (!room || room.currentDrawer !== socket.id || room.phase !== 'drawing') return;
        socket.to(room.code).emit('draw-stroke', data);
    });

    socket.on('draw-clear', () => {
        const room = drawRooms[socket.drawRoom];
        if (!room || room.currentDrawer !== socket.id) return;
        io.to(room.code).emit('draw-clear');
    });

    socket.on('draw-guess', ({ text }) => {
        const room = drawRooms[socket.drawRoom];
        if (!room || room.phase !== 'drawing') return;
        if (room.currentDrawer === socket.id)  return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || room.correctGuessers.includes(socket.id)) return;

        const guess = text.trim().toLowerCase();
        const word  = room.currentWord.toLowerCase();

        if (guess === word) {
            const pts = Math.max(50, Math.round(500 * (room.timeLeft / 80)));
            player.score += pts;
            room.correctGuessers.push(socket.id);
            const drawer = room.players.find(p => p.id === room.currentDrawer);
            if (drawer) drawer.score += 30;

            io.to(room.code).emit('draw-chat', { type: 'correct', text: `${player.username} guessed it! (+${pts} pts)` });
            socket.emit('draw-correct', { pts });
            io.to(room.code).emit('draw-score-update', {
                scores: room.players.map(p => ({ id: p.id, username: p.username, score: p.score }))
            });
        } else {
            const isClose = levenshtein(guess, word) === 1;
            io.to(room.code).emit('draw-chat', { type: 'guess', username: player.username, text: text.trim().substring(0, 100), isClose });
        }
    });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
