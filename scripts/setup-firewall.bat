@echo off
echo =====================================================
echo  WatchSync - Настройка правил брандмауэра Windows
echo  Запустите этот файл от имени Администратора!
echo =====================================================
echo.

:: Удаляем старые правила если есть
netsh advfirewall firewall delete rule name="WatchSync HTTP" > nul 2>&1
netsh advfirewall firewall delete rule name="WatchSync HTTPS" > nul 2>&1
netsh advfirewall firewall delete rule name="WatchSync TURN TCP" > nul 2>&1
netsh advfirewall firewall delete rule name="WatchSync TURN UDP" > nul 2>&1
netsh advfirewall firewall delete rule name="WatchSync WebRTC UDP" > nul 2>&1
netsh advfirewall firewall delete rule name="WatchSync WS Gateway" > nul 2>&1

echo Добавляем правила входящего трафика...

:: HTTP (редирект на HTTPS)
netsh advfirewall firewall add rule name="WatchSync HTTP" dir=in action=allow protocol=TCP localport=8080
if %errorlevel%==0 (echo   [OK] TCP 8080 - HTTP) else (echo   [FAIL] TCP 8080)

:: HTTPS (основной доступ)
netsh advfirewall firewall add rule name="WatchSync HTTPS" dir=in action=allow protocol=TCP localport=8443
if %errorlevel%==0 (echo   [OK] TCP 8443 - HTTPS) else (echo   [FAIL] TCP 8443)

:: TURN сервер для WebRTC NAT traversal
netsh advfirewall firewall add rule name="WatchSync TURN TCP" dir=in action=allow protocol=TCP localport=3478
if %errorlevel%==0 (echo   [OK] TCP 3478 - TURN) else (echo   [FAIL] TCP 3478)

netsh advfirewall firewall add rule name="WatchSync TURN UDP" dir=in action=allow protocol=UDP localport=3478
if %errorlevel%==0 (echo   [OK] UDP 3478 - TURN) else (echo   [FAIL] UDP 3478)

:: WebRTC media (Mediasoup)
netsh advfirewall firewall add rule name="WatchSync WebRTC UDP" dir=in action=allow protocol=UDP localport=40000-40099
if %errorlevel%==0 (echo   [OK] UDP 40000-40099 - WebRTC Media) else (echo   [FAIL] UDP 40000-40099)

echo.
echo Готово! Теперь WatchSync доступен из внешней сети на:
echo   http://<your-server>:8080/
echo   https://<your-server>:8443/
echo.
pause
