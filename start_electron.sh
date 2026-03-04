#!/bin/bash

# Kill any old processes
echo "Stopping any running instances..."
pkill -f uvicorn
pkill -f ffmpeg
fuser -k 8000/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
sleep 2

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Start Backend (Detached)
echo "🚀 Starting Backend..."
cd "$DIR/backend"
# Install requirements automatically
./venv/bin/python3 -m pip install -r requirements.txt

# Run in background
export PYTHONUNBUFFERED=1
nohup ./venv/bin/python main.py > backend_run.log 2>&1 < /dev/null &
BACKEND_PID=$!
echo "✅ Backend started (PID $BACKEND_PID)"

# Start Electron App (Interactive)
echo "🚀 Starting Electron App..."
cd "$DIR/frontend"
# We run this in foreground so we can see output, or user can close it to exit
# npm run electron:dev runs "concurrently" which runs vite and electron
npm run electron:dev
