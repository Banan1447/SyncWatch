// services/authService.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class AuthService {
  constructor() {
    this.usersFilePath = path.join(__dirname, '..', 'users.json');
    this.secret = config.jwtSecret || process.env.JWT_SECRET || 'default_secret_for_dev';
    if (this.secret === 'default_secret_for_dev') {
      console.warn('[AUTH SERVICE] Используется НЕБЕЗОПАСНЫЙ default_secret_for_dev. Установите JWT_SECRET в config/index.js или в переменной окружения.');
    }
    this.users = this.loadUsers();
    
    // Создаем администратора по умолчанию, если его нет (с хешированием)
    this.ensureAdminUser();
  }

  // Создание администратора по умолчанию
  ensureAdminUser() {
    const adminUser = this.users.find(user => user.username === 'admin');
    if (!adminUser) {
      // Используем bcrypt.hashSync для синхронного хеширования при инициализации
      // Это ОК, потому что происходит однократно при запуске приложения
      const hashedPassword = bcrypt.hashSync('admin', 10); // Хешируем 'admin'
      const defaultAdmin = {
        id: 'user_1',
        username: 'admin',
        password: hashedPassword, // Сохраняем хеш, а не plain text
        email: 'admin@localhost',
        role: 'admin',
        createdAt: new Date().toISOString()
      };
      this.users.push(defaultAdmin);
      this.saveUsers();
      console.log('[AUTH SERVICE] Создан администратор по умолчанию: admin/admin (пароль захеширован)');
    } else {
      console.log('[AUTH SERVICE] Администратор уже существует.');
    }
  }

  // Загрузка пользователей из файла
  loadUsers() {
    try {
      if (fs.existsSync(this.usersFilePath)) {
        const data = fs.readFileSync(this.usersFilePath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
      }
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка загрузки пользователей:', error.message);
    }
    return [];
  }

  // Сохранение пользователей в файл
  saveUsers() {
    try {
      const dir = path.dirname(this.usersFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.usersFilePath, JSON.stringify(this.users, null, 2));
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка сохранения пользователей:', error.message);
    }
  }

  // Регистрация нового пользователя (обновленный метод)
  async register(username, email, password) { // Принимаем 3 параметра
    if (this.users.find(user => user.username === username)) {
      throw new Error('Пользователь с таким именем уже существует');
    }
    if (password.length < 6) {
      throw new Error('Пароль должен быть не менее 6 символов');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      id: 'user_' + Date.now(),
      username,
      email, // Сохраняем переданный email
      password: hashedPassword,
      role: 'user', // По умолчанию обычный пользователь
      createdAt: new Date().toISOString()
    };

    this.users.push(newUser);
    this.saveUsers();
    console.log(`[AUTH SERVICE] Зарегистрирован пользователь: ${username}`);
    return { success: true, message: 'Пользователь успешно зарегистрирован' };
  }

  // Вход пользователя
  async login(username, password) {
    const user = this.users.find(u => u.username === username);
    if (!user) {
      throw new Error('Неверное имя пользователя или пароль');
    }

    // УБРАНО: Обход проверки пароля для NODE_ENV=development
    // Теперь пароль администратора по умолчанию захеширован, и проверка должна пройти всегда.
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new Error('Неверное имя пользователя или пароль');
    }

    // Генерация JWT токена
    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
        id: user.id
      },
      this.secret,
      { expiresIn: '24h' }
    );

    console.log(`[AUTH SERVICE] Успешный вход для пользователя: ${username} (${user.role})`);
    return {
      success: true,
      token,
      user: {
        username: user.username,
        role: user.role,
        id: user.id
      }
    };
  }

  // Проверка JWT токена
  verifyToken(token) {
    try {
      return jwt.verify(token, this.secret);
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка проверки токена:', error.message);
      return null;
    }
  }

  // Получение информации о пользователе
  getUser(username) {
    const user = this.users.find(u => u.username === username);
    if (user) {
      // Возвращаем только безопасные поля
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      };
    }
    return null;
  }

  // Получение пользователя по ID
  getUserById(userId) {
    const user = this.users.find(u => u.id === userId);
    if (user) {
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt
      };
    }
    return null;
  }

  // Удаление пользователя
  deleteUser(username) {
    const userIndex = this.users.findIndex(user => user.username === username);
    if (userIndex !== -1) {
      this.users.splice(userIndex, 1);
      this.saveUsers();
      console.log(`[AUTH SERVICE] Удалён пользователь: ${username}`);
      return true;
    }
    return false;
  }

  // Получение всех пользователей (для админки)
  getAllUsers() {
    return this.users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt
    }));
  }
}

module.exports = AuthService;