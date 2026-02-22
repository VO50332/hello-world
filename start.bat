@echo off
setlocal

set PORT=3000

:: Run from the folder that contains this file, regardless of
:: where it was launched from.
cd /d "%~dp0"

echo.
echo  ============================================
echo   WhatsApp Marketplace Bot
echo  ============================================
echo.

:: Start the Node.js app in its own window so logs are separate.
start "WhatsApp Bot" cmd /k "node src/index.js"

:: Give Node.js a moment to bind to the port before the tunnel opens.
timeout /t 3 /nobreak >nul

echo  Starting Cloudflare tunnel...
echo  (Your public URL will appear below. Keep this window open.)
echo.

:: Open the Cloudflare tunnel.
cloudflared tunnel --url http://localhost:%PORT%

:: If we get here the tunnel exited — pause so the user can read any error.
echo.
echo  Tunnel closed. Press any key to exit.
pause >nul
