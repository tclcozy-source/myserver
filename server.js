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

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

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
            room.currentTurn = opponentId;
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
        const code = socket.roomCode;
        if (!code || !rooms[code]) return;
        io.to(code).emit('player-disconnected');
        delete rooms[code];
    });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
