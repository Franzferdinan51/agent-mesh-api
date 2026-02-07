@echo off
REM Agent Mesh API Server Startup Script for Windows
setlocal EnableDelayedExpansion

REM Default values
set PORT=%~1
set API_KEY=%~2

if "%~1"=="" set PORT=4000
if "%~2"=="" set API_KEY=openclaw-mesh-default-key

echo.
echo ===========================================
echo   Agent Mesh API Server
echo ===========================================
echo.
echo Configuration:
echo   Port:     %PORT%
echo   Database: agent-mesh.db
echo.

set PORT=%PORT%
set AGENT_MESH_API_KEY=%API_KEY%

if not exist node_modules (
    echo Installing dependencies...
    npm install
)

echo Starting server...
echo.

node server.js

if errorlevel 1 (
    echo.
    echo [ERROR] Server failed to start
    pause
    exit /b 1
)
