#!/bin/bash
export AGENT_MESH_WS_URL="ws://100.74.88.40:4000/ws"
export AGENT_MESH_API_KEY="openclaw-mesh-default-key"
export AGENT_MESH_NAME="DuckBot"

cd "$(dirname "$0")"
echo "Starting Agent Mesh Client connecting to $AGENT_MESH_WS_URL..."
nohup node websocket-client.js > client.log 2>&1 &
