@echo off
echo 🚀 Starting UltiBot Tools System...

REM Check if server dependencies are installed
if not exist "server\node_modules" (
    echo 📦 Installing server dependencies...
    cd server
    npm install
    cd ..
)

REM Check if client dependencies are installed
if not exist "node_modules" (
    echo 📦 Installing client dependencies...
    npm install
)

REM Check if .env exists
if not exist "server\.env" (
    echo ⚠️  Creating server/.env from template...
    copy server\.env.example server\.env >nul 2>&1
    if errorlevel 1 echo Please create server/.env manually
)

echo 🔧 Starting services...
echo 📊 Frontend: http://localhost:3000
echo 🔧 Backend: http://localhost:8787
echo.

REM Start server in background
echo Starting server...
start /B npm --prefix server run dev

REM Wait a moment for server to start
timeout /t 3 /nobreak >nul

REM Start client
echo Starting client...
start /B npm run dev

echo.
echo ✅ System started successfully!
echo Press Ctrl+C to stop all services
pause
