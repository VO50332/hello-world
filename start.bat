@echo off
setlocal

:: ─────────────────────────────────────────────────────────────
::  Change SUBDOMAIN to any name you want (must be unique on
::  serveo.net).  Your permanent URL will be:
::  https://YOUR-SUBDOMAIN.serveo.net
:: ─────────────────────────────────────────────────────────────
set SUBDOMAIN=whatsapp-marketplace
set PORT=3000

:: Run from the folder that contains this file, regardless of
:: where it was launched from.
cd /d "%~dp0"

echo.
echo  ============================================
echo   WhatsApp Marketplace Bot
echo   Public URL: https://%SUBDOMAIN%.serveo.net
echo  ============================================
echo.

:: Start the Node.js app in its own window so logs are separate.
start "WhatsApp Bot" cmd /k "node src/index.js"

:: Give Node.js a moment to bind to the port before the tunnel opens.
timeout /t 3 /nobreak >nul

echo  Tunnel connecting to serveo.net...
echo  (Keep this window open. Press Ctrl+C to shut everything down.)
echo.

:: Open the SSH tunnel.
::   -R subdomain:80:localhost:PORT  — forward serveo port 80 to local app
::   ServerAliveInterval/CountMax    — reconnects if the connection drops
::   StrictHostKeyChecking           — auto-accept serveo's host key on first run
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R %SUBDOMAIN%:80:localhost:%PORT% serveo.net

:: If we get here the tunnel exited — pause so the user can read any error.
echo.
echo  Tunnel closed. Press any key to exit.
pause >nul
