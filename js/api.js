const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./config');
const { logRequests } = require('./middleware/logging');
const { authenticateToken, isAdmin } = require('./middleware/auth');

const app = express();

// Настройки
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Увеличено ограничение для больших JSON (шаблоны)
app.use(express.static(path.join(__dirname, 'public')));
app.use(logRequests);

// Маршруты API
app.use('/api/admin', require('./routes/admin'));
app.use('/api/transcode', require('./routes/transcode')); // ✅ Добавлен маршрут транскодирования

// Обслуживание HTML-файлов
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', authenticateToken, isAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/select-room.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'select-room.html'));
});

// Специальный маршрут для transcode.html
app.get('/transcode', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'transcode.html'));
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

const port = config.port || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Admin panel available at http://localhost:${port}/admin`);
    console.log(`Transcode panel available at http://localhost:${port}/transcode`);
});