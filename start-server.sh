#!/bin/bash
# Agent Mesh API Server Startup Script for Linux/Mac

# Default values
PORT=${1:-4000}
API_KEY=${2:-openclaw-mesh-default-key}

echo ""
echo "==========================================="
echo "  Agent Mesh API Server"
echo "==========================================="
echo ""
echo "Configuration:"
echo "  Port:     $PORT"
echo "  Database: agent-mesh.db"
echo ""

export PORT=$PORT
export AGENT_MESH_API_KEY=$API_KEY

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Starting server..."
echo ""

node server.js
