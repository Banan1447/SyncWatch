// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
    console.log('Скрипт загружен и DOM готов');
    
    // Инициализация компонентов
    initComponents();
    initEvents();
    initApi();
});

// Инициализация компонентов интерфейса
function initComponents() {
    // Здесь можно добавить инициализацию различных элементов интерфейса
    const header = document.querySelector('header');
    const mainContent = document.querySelector('.main-content');
    
    // Пример настройки заголовка
    header.classList.add('active');
}

// Настройка обработчиков событий
function initEvents() {
    // Обработчик клика по кнопке
    document.querySelector('.admin-button').addEventListener('click', () => {
        alert('Кнопка нажата!');
    });
    
    // Обработчик отправки формы
    document.querySelector('form').addEventListener('submit', (e) => {
        e.preventDefault();
        handleFormSubmit(e.target);
    });
}

// Работа с API
function initApi() {
    // Пример запроса к API
    fetch('/api/data')
        .then(response => response.json())
        .then(data => {
            console.log('Данные получены:', data);
            renderData(data);
        })
        .catch(error => console.error('Ошибка при получении данных:', error));
}

// Обработка отправки формы
function handleFormSubmit(form) {
    const data = new FormData(form);
    
    fetch('/api/submit', {
        method: 'POST',
        body: data
    })
    .then(response => response.json())
    .then(result => {
        if (result.success) {
            alert('Данные успешно отправлены!');
            form.reset();
        } else {
            alert('Ошибка при отправке данных');
        }
    })
    .catch(error => console.error('Ошибка:', error));
}

// Рендер данных
function renderData(data) {
    const container = document.querySelector('.data-container');
    container.innerHTML = '';
    
    data.forEach(item => {
        const element = document.createElement('div');
        element.classList.add('data-item');
        element.innerHTML = `
            <h3>${item.title}</h3>
            <p>${item.description}</p>
        `;
        container.appendChild(element);
    });
}

// Дополнительные функции
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.classList.add('notification', type);
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 3000);
}
