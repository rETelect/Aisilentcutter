#!/bin/bash

# Kill any old processes
echo "Stopping existing servers..."
fuser -k 8000/tcp 2>/dev/null
fuser -k 5173/tcp 2>/dev/null
sleep 2

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"

# Start Backend
echo "Starting Backend..."
cd "$DIR/backend"
# Redirect stdin from /dev/null to prevent reading from terminal
nohup ./venv/bin/python main.py > backend_run.log 2>&1 < /dev/null &
BACKEND_PID=$!
echo "Backend started (PID $BACKEND_PID)"

# Start Frontend
echo "Starting Frontend..."
cd "$DIR/frontend"
# Redirect stdin from /dev/null 
nohup npx vite --host > frontend_run.log 2>&1 < /dev/null &
FRONTEND_PID=$!
echo "Frontend started (PID $FRONTEND_PID)"

echo "Done. Servers running in background."
