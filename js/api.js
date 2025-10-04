export const initApi = () => {
  const loadConfig = async () => {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      
      if (data.success) {
        updateCurrentSettings(data);
      } else {
        console.error('Ошибка получения настроек:', data