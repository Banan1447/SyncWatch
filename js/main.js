// Инициализация при загрузке DOM
document.addEventListener('DOMContentLoaded', () => {
    console.log('Скрипт main.js загружен');
    
    // Инициализация компонентов
    initComponents();
    initEvents();
});

// Инициализация компонентов
function initComponents() {
    // Здесь можно добавить инициализацию компонентов
    const container = document.querySelector('.container');
    if (container) {
        container.classList.add('loaded');
    }
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
        console.error('Ошибка при отправке:', error);
    });
}

// Функция для показа уведомлений
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.classList.add('notification', type);
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}
