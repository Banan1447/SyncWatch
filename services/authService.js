// services/authService.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class AuthService {
  constructor() {
    this.usersFilePath = path.join(__dirname, '..', 'users.json');
    this.groupsFilePath = path.join(__dirname, '..', 'user-groups.json');
    this.secret = config.jwtSecret || process.env.JWT_SECRET || 'default_secret_for_dev';
    if (this.secret === 'default_secret_for_dev') {
      console.warn('[AUTH SERVICE] Используется НЕБЕЗОПАСНЫЙ default_secret_for_dev. Установите JWT_SECRET в config/index.js или в переменной окружения.');
    }
    this.users = this.loadUsers();
    this.groups = this.loadGroups();

    // Отмечаем, что инициализация еще не завершена
    this.initialized = false;
  }

  // Асинхронная инициализация сервиса
  async initialize() {
    if (!this.initialized) {
      await this.ensureAdminUser();
      this.initialized = true;
    }
  }

  // Загрузка групп пользователей
  loadGroups() {
    try {
      if (fs.existsSync(this.groupsFilePath)) {
        const data = fs.readFileSync(this.groupsFilePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn('[AUTH SERVICE] Could not load user groups:', err.message);
    }

    // Создаем группы по умолчанию
    const defaultGroups = {
      'admin': {
        id: 'admin',
        name: 'Администраторы',
        description: 'Полный доступ ко всем функциям системы',
        permissions: ['admin', 'manage_users', 'manage_rooms', 'manage_files', 'view_logs'],
        roomAccess: ['all'], // Доступ ко всем комнатам
        createdAt: new Date().toISOString()
      },
      'moderator': {
        id: 'moderator',
        name: 'Модераторы',
        description: 'Управление комнатами и пользователями',
        permissions: ['manage_rooms', 'kick_users', 'view_logs'],
        roomAccess: ['all'],
        createdAt: new Date().toISOString()
      },
      'user': {
        id: 'user',
        name: 'Пользователи',
        description: 'Стандартные пользователи',
        permissions: ['create_rooms', 'join_rooms'],
        roomAccess: ['public'], // Доступ только к публичным комнатам
        createdAt: new Date().toISOString()
      },
      'premium': {
        id: 'premium',
        name: 'Премиум пользователи',
        description: 'Расширенные возможности',
        permissions: ['create_rooms', 'join_rooms', 'upload_files', 'transcode'],
        roomAccess: ['public', 'premium'],
        createdAt: new Date().toISOString()
      }
    };

    this.saveGroups(defaultGroups);
    return defaultGroups;
  }

  // Сохранение групп
  saveGroups(groups = this.groups) {
    try {
      fs.writeFileSync(this.groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
    } catch (err) {
      console.error('[AUTH SERVICE] Failed to save groups:', err);
    }
  }

  // Получение всех групп
  getAllGroups() {
    return Object.values(this.groups);
  }

  // Создание новой группы
  createGroup(groupData) {
    try {
      const { id, name, description, permissions, roomAccess, createdAt } = groupData;

      // Проверяем, существует ли группа с таким ID
      if (this.groups[id]) {
        return { success: false, error: 'Группа с таким ID уже существует' };
      }

      // Создаем новую группу
      this.groups[id] = {
        id,
        name,
        description: description || '',
        permissions: permissions || [],
        roomAccess: roomAccess || [],
        createdAt: createdAt || new Date().toISOString()
      };

      this.saveGroups();
      return { success: true, group: this.groups[id] };
    } catch (error) {
      console.error('[AUTH SERVICE] Error creating group:', error);
      return { success: false, error: 'Ошибка при создании группы' };
    }
  }

  // Обновление группы
  updateGroup(groupId, updateData) {
    try {
      if (!this.groups[groupId]) {
        return { success: false, error: 'Группа не найдена' };
      }

      const group = this.groups[groupId];

      // Обновляем только переданные поля
      if (updateData.name !== undefined) group.name = updateData.name;
      if (updateData.description !== undefined) group.description = updateData.description;
      if (updateData.permissions !== undefined) group.permissions = updateData.permissions;
      if (updateData.roomAccess !== undefined) group.roomAccess = updateData.roomAccess;

      this.saveGroups();
      return { success: true, group };
    } catch (error) {
      console.error('[AUTH SERVICE] Error updating group:', error);
      return { success: false, error: 'Ошибка при обновлении группы' };
    }
  }

  // Удаление группы
  deleteGroup(groupId) {
    try {
      if (!this.groups[groupId]) {
        return { success: false, error: 'Группа не найдена' };
      }

      // Проверяем, используется ли группа пользователями
      const usersUsingGroup = this.users.filter(user =>
        user.groups && user.groups.includes(groupId)
      );

      if (usersUsingGroup.length > 0) {
        return { success: false, error: `Группа используется ${usersUsingGroup.length} пользователями` };
      }

      delete this.groups[groupId];
      this.saveGroups();
      return { success: true };
    } catch (error) {
      console.error('[AUTH SERVICE] Error deleting group:', error);
      return { success: false, error: 'Ошибка при удалении группы' };
    }
  }

  // Создание администратора по умолчанию (асинхронно)
  async ensureAdminUser() {
    try {
      const adminUser = this.users.find(user => user.username === 'admin');
      if (!adminUser) {
        // Используем bcrypt.hash для асинхронного хеширования
        const hashedPassword = await bcrypt.hash('admin', 10);
        const defaultAdmin = {
          id: 'user_1',
          username: 'admin',
          password: hashedPassword,
          email: 'admin@localhost',
          role: 'admin',
          groups: ['admin', 'moderator'],
          profile: {
            firstName: 'System',
            lastName: 'Administrator',
            displayName: 'Administrator'
          },
          lastLogin: null,
          loginCount: 0,
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        this.users.push(defaultAdmin);
        this.saveUsers();
        console.log('[AUTH SERVICE] Создан администратор по умолчанию: admin/admin (пароль захеширован)');
      } else {
        console.log('[AUTH SERVICE] Администратор уже существует.');
      }
    } catch (error) {
      console.error('[AUTH SERVICE] Ошибка создания администратора по умолчанию:', error);
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
      groups: user.groups || [],
      isActive: user.isActive !== false,
      profile: user.profile || {},
      createdAt: user.createdAt
    }));
  }

  // Обновление пользователя
  updateUser(userId, updateData) {
    try {
      const userIndex = this.users.findIndex(user => user.id === userId);
      if (userIndex === -1) {
        throw new Error('Пользователь не найден');
      }

      const user = this.users[userIndex];

      // Обновляем только разрешенные поля
      if (updateData.email !== undefined) {
        user.email = updateData.email;
      }

      if (updateData.password) {
        // Хэшируем новый пароль
        user.password = bcrypt.hashSync(updateData.password, 10);
      }

      if (updateData.groups !== undefined) {
        user.groups = updateData.groups;
      }

      if (updateData.profile !== undefined) {
        user.profile = { ...user.profile, ...updateData.profile };
      }

      this.saveUsers();

      // Возвращаем обновленного пользователя без пароля
      const { password, ...userWithoutPassword } = user;
      return userWithoutPassword;
    } catch (error) {
      console.error('[AUTH SERVICE] Error updating user:', error);
      throw error;
    }
  }

  // Переключение статуса пользователя
  toggleUserStatus(userId) {
    const userIndex = this.users.findIndex(user => user.id === userId);
    if (userIndex === -1) {
      throw new Error('Пользователь не найден');
    }

    const user = this.users[userIndex];
    user.isActive = !user.isActive;
    this.saveUsers();
    return user.isActive;
  }
}

module.exports = AuthService;