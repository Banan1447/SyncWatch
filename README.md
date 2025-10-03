# SyncWatch

## Описание / Description

SyncWatch — это инструмент для отслеживания и синхронизации видео в очереди на YouTube. Он позволяет автоматически запускать следующее видео из очереди, когда текущее завершается, и поддерживает простой интерфейс для управления.

SyncWatch is a tool for monitoring and synchronizing YouTube video queues. It automatically plays the next video in the queue when the current one ends, and provides a simple interface for managing the queue.

---

## Установка / Installation

1. Убедитесь, что у вас установлен **Node.js** (версия 16 или выше) и **npm**.
2. Скачайте или клонируйте репозиторий:
   ```bash
   git clone https://github.com/Banan1447/SyncWatch.git
   cd SyncWatch
   ```
3. Установите зависимости:
   ```bash
   npm install
   ```

1. Make sure you have **Node.js** (version 16 or higher) and **npm** installed.
2. Clone the repository:
   ```bash
   git clone https://github.com/Banan1447/SyncWatch.git
   cd SyncWatch
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

---

## Запуск / Running

### Через npm скрипты

- Windows:
  ```bash
  npm start
  ```
- Linux/macOS:
  ```bash
  npm start
  ```

### Run

- Windows:
  ```bash
  npm start
  ```
- Linux/macOS:
  ```bash
  npm start
  ```

---

## Конфигурация / Configuration

Настройки приложения хранятся в файле `config.js`:

- `videoDirectory`: путь к папке с видео (по умолчанию `./videos`).
- `port`: порт, на котором запускается сервер (по умолчанию `3000`).

Вы можете изменить эти значения в `config.js` в зависимости от вашей конфигурации.

### Configuration

Application settings are defined in `config.js`:

- `videoDirectory`: path to the video directory (default: `./videos`).
- `port`: port on which the server runs (default: `3000`).

You can modify these values in `config.js` based on your setup.

---

## Использование / Usage

1. Запустите приложение с помощью `npm start`.
2. Откройте браузер и перейдите на `http://localhost:3000`.
3. Введите URL YouTube видео в поле "Add Video" и нажмите "Add".
4. Видео будет добавлено в очередь.
5. Когда текущее видео завершится, следующее начнёт проигрываться автоматически.

1. Run the app using `npm start`.
2. Open your browser and go to `http://localhost:3000`.
3. Enter a YouTube video URL in the "Add Video" field and click "Add".
4. The video will be added to the queue.
5. When the current video ends, the next one will start automatically.

---

## Файлы

- `config.js` — файл конфигурации (порта и пути к видео).
- `package.json` — содержит скрипты и зависимости.
- `main.js` — основной файл приложения (или аналогичный, в зависимости от структуры).
- `start.sh` — скрипт запуска (Linux/macOS).
- `start.bat` — скрипт запуска (Windows).

---

## Лицензия / License

MIT License — see [LICENSE](LICENSE) for details.
</content