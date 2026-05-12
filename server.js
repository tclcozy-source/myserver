const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware: parse JSON bodies and serve static files from /public
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.get('/api/info', (req, res) => {
    res.json({
        name: 'Shahmeer',
        age: 12,
        server: 'Node.js + Express',
        status: 'online',
        uptime: Math.floor(process.uptime()) + ' seconds'
    });
});

app.post('/api/contact', (req, res) => {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    const messagesFile = path.join(__dirname, 'data', 'messages.json');
    const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));

    messages.push({ name, email, message, date: new Date().toISOString() });

    fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2));

    res.json({ message: `Thanks ${name}! Your message was saved.` });
});

const MESSAGES_PASSWORD = 'shahmeer123';

app.get('/api/messages', (req, res) => {
    if (req.headers['x-password'] !== MESSAGES_PASSWORD) {
        return res.status(401).json({ error: 'Wrong password.' });
    }
    const messagesFile = path.join(__dirname, 'data', 'messages.json');
    const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    res.json(messages);
});

// Page Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

app.get('/messages', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

// 404 handler — must be last
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
