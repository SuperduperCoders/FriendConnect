@echo off
title Friendnix Launcher
color 0D
echo.
echo  =========================================
echo   Friendnix - Starting up...
echo  =========================================
echo.

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Node.js is not installed!
    echo  Please install it from https://nodejs.org
    pause
    exit /b 1
)

echo  [1/4] Installing backend dependencies...
cd backend
call npm install --silent
if errorlevel 1 (
    echo  ERROR: Failed to install backend deps
    pause
    exit /b 1
)

echo  [2/4] Installing frontend dependencies...
cd ..\frontend
call npm install --silent
if errorlevel 1 (
    echo  ERROR: Failed to install frontend deps
    pause
    exit /b 1
)

echo  [3/4] Building frontend...
call npm run build
if errorlevel 1 (
    echo  ERROR: Frontend build failed
    pause
    exit /b 1
)

cd ..

echo  [4/4] Starting server...
start "Friendnix" cmd /k "cd /d %~dp0backend && node server.js"

echo.
echo  =========================================
echo   Friendnix is starting!
echo.
echo   Open: http://localhost:3001
echo.
echo   Friends on your WiFi can join at:
echo   http://[your-IP]:3001
echo   (the server window will show your IP)
echo  =========================================
echo.
timeout /t 3 /nobreak >nul
start "" "http://localhost:3001"
