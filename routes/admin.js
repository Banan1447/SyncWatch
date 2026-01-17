// routes/admin.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const config = require('../config');

// Middleware для проверки админских прав
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ success: false, error: 'Токен отсутствует' });
    }

    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        
        // Проверяем, что пользователь администратор
        if (decoded.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Недостаточно прав' });
        }
        
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Неверный токен' });
    }
};

// Аутентификация администратора
router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    
    // Простая проверка - в реальном приложении используйте базу данных
    if (username === 'admin' && password === 'admin') {
        const token = jwt.sign(
            { 
                id: 1, 
                username: 'admin', 
                role: 'admin' 
            }, 
            config.jwtSecret, 
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: {
                id: 1,
                username: 'admin',
                role: 'admin'
            }
        });
    } else {
        res.status(401).json({
            success: false,
            error: 'Неверные учетные данные'
        });
    }
});

// Получение профиля
router.get('/auth/profile', authenticateAdmin, (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});

// Статистика системы
router.get('/admin/stats', authenticateAdmin, (req, res) => {
    // Здесь должна быть реальная статистика из вашей системы
    res.json({
        success: true,
        stats: {
            rooms: {
                active: 5,
                total: 12
            },
            users: {
                active: 42,
                registered: 150
            },
            transcode: {
                activeJobs: 2,
                totalJobs: 45,
                templates: 3
            },
            system: {
                uptime: process.uptime(),
                memory: {
                    heapUsed: process.memoryUsage().heapUsed,
                    heapTotal: process.memoryUsage().heapTotal
                }
            }
        }
    });
});

// Список комнат
router.get('/admin/rooms', authenticateAdmin, (req, res) => {
    // Заглушка - замените на реальные данные
    res.json({
        success: true,
        rooms: [
            {
                id: 'room-1',
                name: 'Тестовая комната',
                users: 3,
                currentVideo: 'video1.mp4',
                createdAt: new Date().toISOString()
            },
            {
                id: 'room-2', 
                name: 'Кино вечер',
                users: 0,
                currentVideo: null,
                createdAt: new Date(Date.now() - 86400000).toISOString()
            }
        ]
    });
});

// Удаление комнаты
router.delete('/admin/rooms/:id', authenticateAdmin, (req, res) => {
    const roomId = req.params.id;
    // Реализуйте удаление комнаты
    res.json({
        success: true,
        message: `Комната ${roomId} удалена`
    });
});

// Список пользователей
router.get('/admin/users', authenticateAdmin, (req, res) => {
    // Заглушка - замените на реальные данные
    res.json({
        success: true,
        users: [
            {
                id: 'user-1',
                username: 'testuser',
                email: 'test@example.com',
                role: 'user',
                createdAt: new Date().toISOString()
            },
            {
                id: 'user-2',
                username: 'admin',
                email: 'admin@example.com', 
                role: 'admin',
                createdAt: new Date().toISOString()
            }
        ]
    });
});

// Очередь транскодирования
router.get('/admin/transcode/queue', authenticateAdmin, (req, res) => {
    res.json({
        success: true,
        queue: [
            {
                id: 'job-1',
                fileId: 'video123.mp4',
                templateId: '720p',
                status: 'processing',
                progress: 65,
                createdAt: new Date().toISOString()
            },
            {
                id: 'job-2',
                fileId: 'movie456.mkv', 
                templateId: '1080p',
                status: 'pending',
                progress: 0,
                createdAt: new Date().toISOString()
            }
        ]
    });
});

// Шаблоны транскодирования
router.get('/admin/transcode/templates', authenticateAdmin, (req, res) => {
    res.json({
        success: true,
        templates: [
            {
                id: '720p',
                name: 'HD 720p',
                description: 'Высокое качество 720p',
                command: 'ffmpeg -i input.mp4 -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k output.mp4',
                createdAt: new Date().toISOString()
            },
            {
                id: '1080p',
                name: 'Full HD 1080p',
                description: 'Полное HD 1080p',
                command: 'ffmpeg -i input.mp4 -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 192k output.mp4',
                createdAt: new Date().toISOString()
            }
        ]
    });
});

// Системные метрики
router.get('/metrics/performance', authenticateAdmin, (req, res) => {
    const memUsage = process.memoryUsage();
    
    res.json({
        success: true,
        metrics: {
            responseTime: {
                average: 45,
                min: 12,
                max: 230
            },
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024)
            },
            system: {
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform,
                activeConnections: 15
            }
        }
    });
});

module.exports = router;