// app.js
const express = require('express');
const path = require('path');
const config = require('./config');
const adminRoutes = require('./routes/admin'); // Добавьте эту строку

const app = express();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Маршруты
app.use('/api', adminRoutes); // Добавьте эту строку

// Обслуживание admin.html
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`Admin panel available at http://localhost:${config.port}/admin`);
});