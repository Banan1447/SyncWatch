// services/authService.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
// Импортируем config для получения jwtSecret
const config = require('../config');

class AuthService {
  constructor() {
    this.usersFilePath = path.join(__dirname, '..', 'json', 'users.json');
    // Используем jwtSecret из config, с fallback на env или default
    // ВАЖНО: Убедитесь, что config.jwtSecret в config/index.js содержит ваш секретный ключ
    this.secret = config.jwtSecret || process.env.JWT_SECRET || 'default_secret_for_dev';
    if (this.secret === 'default_secret_for_dev') {
      console.warn('[AUTH SERVICE] Используется НЕБЕЗОПАСНЫЙ default_secret_for_dev. Установите JWT_SECRET в config/index.js или в переменной окружения.');
    }
    this.users = this.loadUsers();
  }

  // Загрузка пользователей из файла
  loadUsers() {
    try {
      if (fs.existsSync(this.usersFilePath)) {
        const data = fs.readFileSync(this.usersFilePath, 'utf8');
        const parsed = JSON.parse(data);
        // Убедимся, что это объект
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
      }
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка загрузки пользователей:', error.message);
    }
    return {};
  }

  // Сохранение пользователей в файл
  saveUsers() {
    try {
      // Создаём папку, если она не существует
      const dir = path.dirname(this.usersFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usersFilePath, JSON.stringify(this.users, null, 2));
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка сохранения пользователей:', error.message);
    }
  }

  // Регистрация нового пользователя
  async register(username, password) {
    if (this.users[username]) {
      throw new Error('Пользователь с таким именем уже существует');
    }
    if (password.length < 6) {
      throw new Error('Пароль должен быть не менее 6 символов');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    this.users[username] = {
      username,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      // ... другие поля пользователя, если нужно (например, isAdmin) ...
    };
    this.saveUsers();
    console.log(`[AUTH SERVICE] Зарегистрирован пользователь: ${username}`);
    return { success: true, message: 'Пользователь успешно зарегистрирован' };
  }

  // Вход пользователя
  async login(username, password) {
    const user = this.users[username];
    if (!user) {
      throw new Error('Неверное имя пользователя или пароль');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new Error('Неверное имя пользователя или пароль');
    }

    // Генерация JWT токена
    // Используем this.secret, который был установлен из config в конструкторе
    const token = jwt.sign(
      { username: user.username },
      this.secret, // <-- Вот здесь используется секрет из config
      { expiresIn: '24h' } // Токен действителен 24 часа
    );

    console.log(`[AUTH SERVICE] Успешный вход для пользователя: ${username}`);
    return { success: true, token, user: { username: user.username } };
  }

  // Проверка JWT токена
  verifyToken(token) {
    try {
      // Используем this.secret, который был установлен из config в конструкторе
      return jwt.verify(token, this.secret); // <-- Вот здесь используется секрет из config для проверки
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка проверки токена:', error.message);
      return null;
    }
  }

  // Получение информации о пользователе (только основную, не пароль)
  getUser(username) {
    const user = this.users[username];
    if (user) {
      // Возвращаем только безопасные поля
      return {
        username: user.username,
        createdAt: user.createdAt,
        // Не включаем поле password
      };
    }
    return null;
  }

  // Удаление пользователя (опционально)
  deleteUser(username) {
    if (this.users[username]) {
      delete this.users[username];
      this.saveUsers();
      console.log(`[AUTH SERVICE] Удалён пользователь: ${username}`);
      return true;
    }
    return false;
  }
}

module.exports = AuthService;
