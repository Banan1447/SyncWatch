const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Store {
  constructor(defaults = {}) {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'config.json');
    this._defaults = defaults;
    this._data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      return { ...this._defaults, ...JSON.parse(raw) };
    } catch {
      return { ...this._defaults };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this._data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Store write error:', e);
    }
  }

  get(key, fallback) {
    const val = this._data[key];
    return val !== undefined ? val : (fallback !== undefined ? fallback : this._defaults[key]);
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
  }

  delete(key) {
    delete this._data[key];
    this._save();
  }
}

module.exports = Store;
