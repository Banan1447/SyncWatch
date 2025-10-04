// server/services/authService.js
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const USERS_FILE = path.join(__dirname, '../../users.json');

class AuthService {
  constructor() {
    this.loadUsers();
  }

  loadUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
      }
      // Создаем файл с пользователем по умолчанию
      const defaultUsers = [
        {
          id: 'user_1',
          username: 'admin',
          password: 'admin', // В продакшене нужно хэшировать!
          email: 'admin@localhost',
          role: 'admin',
          createdAt: new Date().toISOString()
        }
      ];
      this.saveUsers(defaultUsers);
      return defaultUsers;
    } catch (err) {
      console.error('[AUTH SERVICE] Ошибка загрузки пользователей:', err);
      return [];
    }
  }

  saveUsers(users) {
    try {
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
      return true;
    } catch (err) {
      console.error('[AUTH SERVICE] Ошибка сохранения пользователей:', err);
      return false;
    }
  }

  findUser(username) {
    const users = this.loadUsers();
    return users.find(user => user.username === username);
  }

  findUserById(id) {
    const users = this.loadUsers();
    return users.find(user => user.id === id);
  }

  createUser(username, password, email = '', role = 'user') {
    const users = this.loadUsers();
    
    if (this.findUser(username)) {
      throw new Error('User already exists');
    }

    const newUser = {
      id: 'user_' + Math.random().toString(36).substr(2, 8),
      username,
      password, // В продакшене нужно хэшировать!
      email,
      role,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    
    if (this.saveUsers(users)) {
      return newUser;
    } else {
      throw new Error('Failed to save user');
    }
  }

  generateToken(user) {
    const payload = {
      id: user.id,
      username: user.username,
      role: user.role
    };
    
    return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch (err) {
      throw new Error('Invalid token');
    }
  }

  login(username, password) {
    const user = this.findUser(username);
    if (!user || user.password !== password) { // В продакшене нужно сравнивать хэши!
      throw new Error('Invalid credentials');
    }

    const token = this.generateToken(user);
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      },
      token
    };
  }

  register(username, password, email = '') {
    const user = this.createUser(username, password, email);
    const token = this.generateToken(user);
    
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      },
      token
    };
  }
}

module.exports = AuthService;