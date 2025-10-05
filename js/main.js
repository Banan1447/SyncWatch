// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
    console.log('Скрипт main.js загружен');
    
    // Инициализация компонентов
    initComponents();
    initEvents();
    
    // Инициализация работы с конфигурацией
    initConfig();
});

// Инициализация компонентов
function initComponents() {
    const container = document.querySelector('.container');
    if (container) {
        container.classList.add('loaded');
    }
}

// Инициализация работы с конфигурацией
function initConfig() {
    const configDataDiv = document.getElementById('config-data');
    const saveButton = document.getElementById('save-config');

    // Получаем данные конфигурации
    fetch('/api/config')
        .then(response => response.json())
        .then(data => {
            renderConfigForm(data);
        })
        .catch(error => {
            showNotification('Ошибка получения конфигурации', 'error');
            console.error('Ошибка получения конфигурации:', error);
        });

    // Обработчик сохранения
    saveButton.addEventListener('click', () => {
        const formData = new FormData(configDataDiv);
        const configData = Object.fromEntries(formData.entries());

        // Базовая валидация
        if (!configData.port || 
            !configData.videoDirectory || 
            !configData.jwtSecret || 
            !configData.jwtExpiresIn) {
            showNotification('Заполните все поля', 'error');
            return;
        }

        fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(configData)
        })
        .then(response => response.json())
        .then(data => {
            showNotification('Конфигурация сохранена', 'success');
            renderConfigForm(data);
        })
        .catch(error => {
            showNotification('Ошибка сохранения', 'error');
            console.error('Ошибка сохранения:', error);
        });
    });
}

function renderConfigForm(config) {
    const html = `
        <div class="config-item">
            <label>Порт сервера:</label>
            <input type="number" name="port" value="${config.port}" required>
        </div>

        <div class="config-item">
            <label>Папка для видео:</label>
            <input type="text" name="videoDirectory" value="${config.videoDirectory}" required>
        </div>

        <div class="config-item">
            <label>JWT секретный ключ:</label>
            <input type="text" name="jwtSecret" value="${config.jwtSecret}" required>
        </div>

        <div class="config-item">
            <label>Время жизни JWT:</label>
            <input type="text" name="jwtExpiresIn" value="${config.jwtExpiresIn}" required>
        </div>
    `;

    document.getElementById('config-data').innerHTML = html;
    document.getElementById('save-config').style.display = 'block';
}

// Настройка обработчиков событий
function initEvents() {
    // Пример обработчика для кнопок
    document.querySelectorAll('button').forEach(button => {
        button.addEventListener('click', () => {
            alert('Кнопка нажата!');
        });
    });

    // Обработчик отправки формы
    document.querySelectorAll('form').forEach(form => {
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            handleFormSubmit(form);
        });
    });
}

// Обработка отправки формы
function handleFormSubmit(form) {
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    fetch('/api/submit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(data => {
        console.log('Данные отправлены:', data);
        form.reset();
    })
    .catch(error => {
        console.error('