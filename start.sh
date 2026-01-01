#!/bin/bash

echo "🚀 Starting UltiBot Tools System..."

# Check if server dependencies are installed
if [ ! -d "server/node_modules" ]; then
    echo "📦 Installing server dependencies..."
    cd server && npm install && cd ..
fi

# Check if client dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing client dependencies..."
    npm install
fi

# Check if .env exists
if [ ! -f "server/.env" ]; then
    echo "⚠️  Creating server/.env from template..."
    cp server/.env.example server/.env 2>/dev/null || echo "Please create server/.env manually"
fi

echo "🔧 Starting services..."
echo "📊 Frontend: http://localhost:3000"
echo "🔧 Backend: http://localhost:8787"
echo ""

# Start server in background
echo "Starting server..."
npm --prefix server run dev &
SERVER_PID=$!

# Wait a moment for server to start
sleep 3

# Start client
echo "Starting client..."
npm run dev &
CLIENT_PID=$!

# Wait for user interrupt
trap "echo '🛑 Shutting down...'; kill $SERVER_PID $CLIENT_PID 2>/dev/null; exit" INT

echo ""
echo "✅ System started successfully!"
echo "Press Ctrl+C to stop all services"
wait
